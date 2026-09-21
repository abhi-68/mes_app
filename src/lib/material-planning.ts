import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  inventoryBalances, inventoryLocations, items, materialRequirements,
  operationDependencies, processedCommands, reservations, stations, taskEvents,
  workOrders, workOrderTasks,
} from "@/db/schema";
import { CommandError, coverageFor, reserveForRequirement, type Exec } from "@/lib/inventory";
import { satisfiedQuantityFor } from "@/lib/outputs";

/** The same location used by Start. Multi-location picking is a separate workflow. */
export async function pickingLocation(exec: Exec = {}) {
  const database = exec.tx ?? exec.db ?? db;
  const [location] = await database.select().from(inventoryLocations)
    .orderBy(asc(inventoryLocations.id)).limit(1);
  return location ?? null;
}

export type MaterialPlanRow = {
  requirementId: number; operationId: number; orderId: number; orderNumber: string;
  operationName: string; stationName: string | null; itemName: string; sku: string;
  unit: string; required: number; issued: number; reserved: number; supplied: number;
  uncovered: number; onHand: number; held: number; free: number;
  fromSubassembly: boolean;
};

export async function materialPlan() {
  const location = await pickingLocation();
  const requirements = await db.select({
    req: materialRequirements, orderId: workOrders.id, orderNumber: workOrders.orderNumber,
    operationName: workOrderTasks.name, stationName: stations.name,
    itemName: items.name, sku: items.sku, unit: items.unitOfMeasure,
  }).from(materialRequirements)
    .innerJoin(workOrderTasks, eq(materialRequirements.operationId, workOrderTasks.id))
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .innerJoin(items, eq(materialRequirements.itemId, items.id))
    .leftJoin(stations, eq(workOrderTasks.stationId, stations.id))
    .where(and(
      inArray(workOrders.status, ["RELEASED", "IN_PROGRESS"]),
      inArray(workOrderTasks.status, ["PENDING", "IN_PROGRESS", "BLOCKED"]),
    )).orderBy(asc(workOrders.dueDate), asc(workOrders.id), asc(workOrderTasks.sequence), asc(materialRequirements.id));
  if (!requirements.length) return { location, rows: [] as MaterialPlanRow[] };
  const ids = requirements.map(r => r.req.id);
  const [commitments, dependencies, balances] = await Promise.all([
    db.select({ requirementId: reservations.requirementId,
      qty: sql<number>`coalesce(sum(${reservations.outstandingQty}), 0)::int`,
    }).from(reservations).where(inArray(reservations.requirementId, ids)).groupBy(reservations.requirementId),
    db.select({ requirementId: operationDependencies.requirementId }).from(operationDependencies)
      .where(and(eq(operationDependencies.type, "REQUIRED_QUANTITY"), inArray(operationDependencies.requirementId, ids))),
    location ? db.select().from(inventoryBalances).where(eq(inventoryBalances.locationId, location.id)) : [],
  ]);
  const reserved = new Map(commitments.map(r => [r.requirementId, r.qty]));
  const childSupplied = new Set(dependencies.map(d => d.requirementId));
  const stock = new Map(balances.map(b => [b.itemId, b]));
  const rows = await Promise.all(requirements.map(async r => {
    const issued = r.req.issuedQty - r.req.returnedQty - r.req.scrappedFromWipQty;
    const committed = reserved.get(r.req.id) ?? 0;
    const fromSubassembly = childSupplied.has(r.req.id);
    const supplied = fromSubassembly ? await satisfiedQuantityFor(r.req.id) : 0;
    const balance = stock.get(r.req.itemId);
    return {
      requirementId: r.req.id, operationId: r.req.operationId, orderId: r.orderId,
      orderNumber: r.orderNumber, operationName: r.operationName, stationName: r.stationName,
      itemName: r.itemName, sku: r.sku, unit: r.unit, required: r.req.requiredQty,
      issued, reserved: committed, supplied,
      uncovered: Math.max(0, r.req.requiredQty - issued - committed - supplied),
      onHand: balance?.onHand ?? 0, held: balance?.heldQty ?? 0,
      free: balance ? balance.onHand - balance.activeReserved - balance.heldQty : 0,
      fromSubassembly,
    };
  }));
  return { location, rows };
}

export type ReservationResult = { reserved: number; uncovered: number; orderId: number };

/** Called only after action authorization. Locks the same task as Start, recomputes
 * demand, and stores the ORIGINAL response so retries cannot reserve later receipts. */
export async function reserveRemainingMaterial(
  input: { commandId: string; requirementId: number; actorUserId: number },
  exec: Exec = {},
): Promise<ReservationResult> {
  const database = exec.db ?? db;
  const perform = async (tx: NonNullable<Exec["tx"]>) => {
    const payloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    // Serialize even duplicate requests addressed at different requirements.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.commandId}, 0))`);
    const [prior] = await tx.select().from(processedCommands).where(eq(processedCommands.commandId, input.commandId));
    if (prior) {
      if (prior.commandType !== "ReserveRemainingMaterial" || prior.payloadHash !== payloadHash) {
        throw new CommandError("This request ID was already used for a different action", "COMMAND_ID_REUSED");
      }
      return JSON.parse(prior.resultRef!) as ReservationResult;
    }
    const [req] = await tx.select().from(materialRequirements).where(eq(materialRequirements.id, input.requirementId));
    if (!req) throw new CommandError("Material requirement not found", "NOT_FOUND");
    const [task] = await tx.select().from(workOrderTasks).where(eq(workOrderTasks.id, req.operationId)).for("update");
    if (!task) throw new CommandError("Operation not found", "NOT_FOUND");
    const [order] = await tx.select().from(workOrders).where(eq(workOrders.id, task.workOrderId));
    if (!order) throw new CommandError("Work order not found", "NOT_FOUND");
    if (task.status === "DONE" || !["RELEASED", "IN_PROGRESS"].includes(order.status)) {
      throw new CommandError("Only unfinished work on a released order can reserve stock", "STATE_GUARD");
    }
    const [child] = await tx.select().from(operationDependencies).where(and(
      eq(operationDependencies.requirementId, req.id), eq(operationDependencies.type, "REQUIRED_QUANTITY"),
    )).limit(1);
    if (child) throw new CommandError("This component is supplied by a sub-assembly. Use its handoff workflow.", "DEPENDENCY");
    const location = await pickingLocation({ tx });
    if (!location) throw new CommandError("No stock location configured", "NOT_FOUND");
    const before = await coverageFor(req.id, { tx });
    let reserved = 0;
    if (before.uncovered > 0) {
      ({ reserved } = await reserveForRequirement({
        commandId: `${input.commandId}:stock`, requirementId: req.id, itemId: req.itemId,
        locationId: location.id, quantity: before.uncovered,
      }, { tx }));
    }
    const after = await coverageFor(req.id, { tx });
    const result = { reserved, uncovered: after.uncovered, orderId: order.id };
    await tx.insert(processedCommands).values({ commandId: input.commandId,
      commandType: "ReserveRemainingMaterial", payloadHash, resultRef: JSON.stringify(result) });
    await tx.insert(taskEvents).values({ workOrderTaskId: task.id, type: "NOTE",
      actorUserId: input.actorUserId, source: "HUMAN",
      payload: { action: "MATERIAL_RESERVED", requirementId: req.id, locationId: location.id, ...result },
    });
    return result;
  };
  return exec.tx ? perform(exec.tx) : database.transaction(perform);
}
