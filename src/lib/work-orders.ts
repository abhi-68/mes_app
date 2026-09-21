import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  workOrders,
  workOrderTasks,
  routingSteps,
  stations,
  bomLines,
  items,
  materialRequirements,
  operationDependencies,
  taskEvents,
} from "@/db/schema";
import { jobNumberFor } from "@/lib/numbering";

/**
 * Releasing a work order does two things:
 *
 *  1. Copies the item's routing template into concrete tasks for THIS order.
 *     Tasks carry their own name/station/expectedMinutes snapshot, so the routing
 *     can be edited later without rewriting history, and this order's steps can be
 *     customised individually.
 *
 *  2. Walks the BOM and, for every component that is MANUFACTURED in-house, spawns
 *     a CHILD work order for it — recursively. That is what produces the
 *     unit -> sub-assembly -> step hierarchy, and what lets each sub-part carry its
 *     own progress. PURCHASED components are not sub-orders; they are simply
 *     consumed from stock at the step their BOM line points at.
 */
export async function releaseWorkOrder(
  workOrderId: number,
  actorUserId: number | null,
  opts: { orderNumberPrefix?: string } = {}
): Promise<void> {
  const order = await db.query.workOrders.findFirst({
    where: eq(workOrders.id, workOrderId),
  });
  if (!order) throw new Error(`Work order ${workOrderId} not found`);

  // --- 1. Materialise the routing into tasks -------------------------------
  const existingTasks = await db
    .select({ id: workOrderTasks.id })
    .from(workOrderTasks)
    .where(eq(workOrderTasks.workOrderId, workOrderId));

  if (existingTasks.length === 0) {
    const steps = await db
      .select()
      .from(routingSteps)
      .where(eq(routingSteps.itemId, order.itemId))
      .orderBy(routingSteps.sequence);

    if (steps.length > 0) {
      // Job numbers are minted here, once, from the order number and the station
      // each step runs at. Assigned in routing order so the numbers read in the
      // order the job travels.
      const stationNumbers = new Map(
        (await db.select({ id: stations.id, number: stations.number }).from(stations)).map(
          (st) => [st.id, st.number]
        )
      );
      const taken: string[] = [];
      const jobNumbers = steps.map((step) => {
        const n = jobNumberFor(
          order.orderNumber,
          step.stationId === null ? null : stationNumbers.get(step.stationId) ?? null,
          taken
        );
        taken.push(n);
        return n;
      });

      await db.insert(workOrderTasks).values(
        steps.map((step, i) => ({
          workOrderId,
          routingStepId: step.id,
          sequence: step.sequence,
          name: step.name,
          stationId: step.stationId,
          expectedMinutes: step.expectedMinutes,
          jobNumber: jobNumbers[i],
          status: "PENDING" as const,
        }))
      );
    }
  }

  // --- 1b. Create material requirements, one per operation ------------------
  // The new inventory engine works against requirements, not raw BOM lines. Each
  // requirement is scoped to a single operation (spec §2), so two operations in one
  // order cannot claim the same stock.
  const tasksNow = await db
    .select()
    .from(workOrderTasks)
    .where(eq(workOrderTasks.workOrderId, workOrderId));

  const bomForItem = await db
    .select()
    .from(bomLines)
    .where(eq(bomLines.parentItemId, order.itemId));

  for (const task of tasksNow) {
    const linesHere = bomForItem.filter((l) => l.consumedAtRoutingStepId === task.routingStepId);
    for (const line of linesHere) {
      const already = await db
        .select({ id: materialRequirements.id })
        .from(materialRequirements)
        .where(
          and(
            eq(materialRequirements.operationId, task.id),
            eq(materialRequirements.itemId, line.componentItemId)
          )
        );
      if (already.length > 0) continue;

      await db.insert(materialRequirements).values({
        operationId: task.id,
        itemId: line.componentItemId,
        requiredQty: line.quantity * order.quantity,
      });
    }
  }

  // --- 2. Spawn child work orders for manufactured components --------------
  const componentLines = await db
    .select({
      bomLineId: bomLines.id,
      quantity: bomLines.quantity,
      componentItemId: bomLines.componentItemId,
      consumedAtRoutingStepId: bomLines.consumedAtRoutingStepId,
      procurementType: items.procurementType,
    })
    .from(bomLines)
    .innerJoin(items, eq(items.id, bomLines.componentItemId))
    .where(eq(bomLines.parentItemId, order.itemId));

  const manufactured = componentLines.filter((l) => l.procurementType === "MANUFACTURED");

  /** bomLineId -> the child work order that satisfies it, however it got there. */
  const childByBomLine = new Map<number, number>();

  for (const [idx, line] of manufactured.entries()) {
    // Don't double-spawn if this child already exists.
    const already = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.parentWorkOrderId, workOrderId),
          eq(workOrders.sourceBomLineId, line.bomLineId)
        )
      );
    if (already.length > 0) {
      childByBomLine.set(line.bomLineId, already[0].id);
      continue;
    }

    const prefix = opts.orderNumberPrefix ?? order.orderNumber;
    const [child] = await db
      .insert(workOrders)
      .values({
        orderNumber: `${prefix}-${String(idx + 1).padStart(2, "0")}`,
        itemId: line.componentItemId,
        customerId: order.customerId,
        quantity: line.quantity * order.quantity,
        dueDate: order.dueDate,
        status: "RELEASED",
        parentWorkOrderId: workOrderId,
        level: order.level + 1,
        sourceBomLineId: line.bomLineId,
        createdByUserId: actorUserId,
      })
      .returning();

    childByBomLine.set(line.bomLineId, child.id);

    // Recurse — a sub-assembly can itself have manufactured sub-components.
    await releaseWorkOrder(child.id, actorUserId, { orderNumberPrefix: child.orderNumber });
  }

  // --- 3. Dependencies -----------------------------------------------------
  await createDependencies(workOrderId, order.quantity, manufactured, childByBomLine);

  await db
    .update(workOrders)
    .set({ status: order.status === "PLANNED" ? "RELEASED" : order.status })
    .where(eq(workOrders.id, workOrderId));
}

/**
 * Turn the routing and the BOM into explicit dependency records.
 *
 * Two kinds come out of this:
 *
 *   - a FULL_COMPLETION chain down the routing, which is what the sequence number
 *     used to imply. Making it explicit means the server can enforce it (the old
 *     gating lived only in the UI) and the worker can be told which step, by name.
 *
 *   - for every MANUFACTURED component, a REQUIRED_QUANTITY and a
 *     QUALITY_ACCEPTANCE dependency from the operation that consumes it onto the
 *     LAST operation of the child work order that builds it. This is the
 *     convergent case: final assembly waits on the fan section, not on the step
 *     numbered before it in its own routing.
 *
 * Idempotent — re-releasing an order does not duplicate records.
 */
async function createDependencies(
  workOrderId: number,
  orderQuantity: number,
  manufactured: {
    bomLineId: number;
    quantity: number;
    componentItemId: number;
    consumedAtRoutingStepId: number | null;
  }[],
  childByBomLine: Map<number, number>
): Promise<void> {
  const tasks = (
    await db.select().from(workOrderTasks).where(eq(workOrderTasks.workOrderId, workOrderId))
  ).sort((a, b) => a.sequence - b.sequence);
  if (tasks.length === 0) return;

  const existing = await db
    .select()
    .from(operationDependencies)
    .where(
      inArray(
        operationDependencies.operationId,
        tasks.map((t) => t.id)
      )
    );
  const seen = new Set(
    existing.map((d) => `${d.operationId}:${d.dependsOnOperationId}:${d.type}`)
  );

  const toInsert: (typeof operationDependencies.$inferInsert)[] = [];
  const stage = (row: typeof operationDependencies.$inferInsert) => {
    const key = `${row.operationId}:${row.dependsOnOperationId ?? null}:${row.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    toInsert.push(row);
  };

  // The routing chain.
  for (let i = 1; i < tasks.length; i++) {
    stage({
      operationId: tasks[i].id,
      dependsOnOperationId: tasks[i - 1].id,
      type: "FULL_COMPLETION",
    });
  }

  // The convergent edges.
  for (const line of manufactured) {
    const childId = childByBomLine.get(line.bomLineId);
    if (!childId) continue;

    const consumer =
      tasks.find((t) => t.routingStepId === line.consumedAtRoutingStepId) ??
      tasks[tasks.length - 1]; // no BOM line pointer: assume final assembly

    const childTasks = await db
      .select()
      .from(workOrderTasks)
      .where(eq(workOrderTasks.workOrderId, childId));
    if (childTasks.length === 0) continue;
    const lastChildTask = childTasks.sort((a, b) => a.sequence - b.sequence).at(-1)!;

    const [requirement] = await db
      .select()
      .from(materialRequirements)
      .where(
        and(
          eq(materialRequirements.operationId, consumer.id),
          eq(materialRequirements.itemId, line.componentItemId)
        )
      );

    stage({
      operationId: consumer.id,
      dependsOnOperationId: lastChildTask.id,
      type: "REQUIRED_QUANTITY",
      requirementId: requirement?.id ?? null,
      requiredQuantity: line.quantity * orderQuantity,
    });

    stage({
      operationId: consumer.id,
      dependsOnOperationId: lastChildTask.id,
      type: "QUALITY_ACCEPTANCE",
    });
  }

  if (toInsert.length > 0) {
    await db.insert(operationDependencies).values(toInsert);
  }
}

// ---------------------------------------------------------------------------
// Progress roll-up
// ---------------------------------------------------------------------------
export type ProgressNode = {
  workOrderId: number;
  orderNumber: string;
  itemName: string;
  itemSku: string;
  level: number;
  status: string;
  /** 0..1, weighted by expected minutes where available, else by step count. */
  progress: number;
  tasksDone: number;
  tasksTotal: number;
  blockedCount: number;
  /** Total estimated minutes for this node and everything under it. */
  weightTotal: number;
  /** Estimated minutes earned so far (in-progress steps count half). */
  weightEarned: number;
  tasks: {
    id: number;
    sequence: number;
    name: string;
    status: string;
    stationName: string | null;
    expectedMinutes: number | null;
    completedByName: string | null;
    completedAt: Date | null;
    blockedNote: string | null;
  }[];
  children: ProgressNode[];
};

/**
 * Builds the unit -> sub-part -> step tree with progress at every level.
 * A parent's progress blends its own steps with its children's progress, so a unit
 * whose coil section is half built reads as genuinely part-done rather than 0%.
 */
export async function getProgressTree(rootWorkOrderId: number): Promise<ProgressNode | null> {
  const all = await collectOrderSubtree(rootWorkOrderId);
  if (all.length === 0) return null;

  const taskRows = await db.query.workOrderTasks.findMany({
    where: inArray(
      workOrderTasks.workOrderId,
      all.map((o) => o.id)
    ),
    with: { station: true, completedBy: true },
  });

  const byOrder = new Map<number, typeof taskRows>();
  for (const t of taskRows) {
    const list = byOrder.get(t.workOrderId) ?? [];
    list.push(t);
    byOrder.set(t.workOrderId, list);
  }

  const orderById = new Map(all.map((o) => [o.id, o]));
  const childrenOf = new Map<number, number[]>();
  for (const o of all) {
    if (o.parentWorkOrderId) {
      const list = childrenOf.get(o.parentWorkOrderId) ?? [];
      list.push(o.id);
      childrenOf.set(o.parentWorkOrderId, list);
    }
  }

  function build(orderId: number): ProgressNode {
    const order = orderById.get(orderId)!;
    const tasks = (byOrder.get(orderId) ?? []).sort((a, b) => a.sequence - b.sequence);
    const children = (childrenOf.get(orderId) ?? []).map(build);

    // Weight every step by its estimated minutes, so a 2-hour step counts for more
    // than a 20-minute one. Sub-assemblies contribute their own real totals rather
    // than a flat per-step guess, which keeps the headline number honest.
    let earned = 0;
    let possible = 0;
    for (const t of tasks) {
      const weight = t.expectedMinutes && t.expectedMinutes > 0 ? t.expectedMinutes : 30;
      possible += weight;
      if (t.status === "DONE") earned += weight;
      else if (t.status === "IN_PROGRESS") earned += weight * 0.5;
    }
    for (const c of children) {
      possible += c.weightTotal;
      earned += c.weightEarned;
    }

    const tasksDone = tasks.filter((t) => t.status === "DONE").length;
    const blockedHere = tasks.filter((t) => t.status === "BLOCKED").length;

    return {
      workOrderId: orderId,
      orderNumber: order.orderNumber,
      itemName: order.itemName,
      itemSku: order.itemSku,
      level: order.level,
      status: order.status,
      progress: possible > 0 ? earned / possible : 0,
      tasksDone: tasksDone + children.reduce((s, c) => s + c.tasksDone, 0),
      tasksTotal: tasks.length + children.reduce((s, c) => s + c.tasksTotal, 0),
      blockedCount: blockedHere + children.reduce((s, c) => s + c.blockedCount, 0),
      weightTotal: possible,
      weightEarned: earned,
      tasks: tasks.map((t) => ({
        id: t.id,
        sequence: t.sequence,
        name: t.name,
        status: t.status,
        stationName: t.station?.name ?? null,
        expectedMinutes: t.expectedMinutes,
        completedByName: t.completedBy?.name ?? null,
        completedAt: t.completedAt,
        blockedNote: t.blockedNote,
      })),
      children,
    };
  }

  return build(rootWorkOrderId);
}

type FlatOrder = {
  id: number;
  orderNumber: string;
  itemName: string;
  itemSku: string;
  level: number;
  status: string;
  parentWorkOrderId: number | null;
};

async function collectOrderSubtree(rootId: number): Promise<FlatOrder[]> {
  const out: FlatOrder[] = [];
  let frontier = [rootId];

  while (frontier.length > 0) {
    const rows = await db
      .select({
        id: workOrders.id,
        orderNumber: workOrders.orderNumber,
        itemName: items.name,
        itemSku: items.sku,
        level: workOrders.level,
        status: workOrders.status,
        parentWorkOrderId: workOrders.parentWorkOrderId,
      })
      .from(workOrders)
      .innerJoin(items, eq(items.id, workOrders.itemId))
      .where(inArray(workOrders.id, frontier));

    out.push(...rows);

    const childRows = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(inArray(workOrders.parentWorkOrderId, frontier));

    frontier = childRows.map((r) => r.id);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inventory consumption
// ---------------------------------------------------------------------------
/*
 * REMOVED — the legacy consumption path.
 *
 * `consumeComponentsForTask` and `receiveFinishedGoods` wrote straight to
 * inventory_items with no idempotency key, no transaction around the surrounding
 * status change, and no sufficiency check. A replayed start consumed materials
 * again and stock could go negative (SUB-FAN-01 reached -3).
 *
 * Inventory is now changed only through src/lib/inventory.ts, which enforces
 * command identity, row locking, the non-negative constraint and reservation
 * ownership. There is deliberately no second way in.
 */

/** Logs an append-only event. Never mutated after insert. */
export async function logTaskEvent(
  taskId: number,
  type: "STARTED" | "COMPLETED" | "BLOCKED" | "UNBLOCKED" | "REOPENED" | "NOTE" | "QUALITY",
  actorUserId: number | null,
  payload?: Record<string, unknown>
): Promise<void> {
  await db.insert(taskEvents).values({
    workOrderTaskId: taskId,
    type,
    actorUserId,
    source: "HUMAN",
    payload: payload ?? null,
  });
}
