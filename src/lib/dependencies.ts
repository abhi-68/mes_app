/**
 * Readiness — IMPL-SPEC §2.
 *
 * The question this file answers is the one Thermal Corp actually asked: *why*
 * can this step not start, in words a person on the floor can act on. Not "it is
 * not your turn" — "final assembly is waiting on 1 fan assembly from Fan & Motor".
 *
 * Two sources of waiting:
 *   1. OperationDependency records (this file's own table)
 *   2. Material that is neither issued, reserved, nor available to reserve
 *
 * Everything here is read-only and batched, because it is rendered per card on
 * list screens. `blockersFor` is the single-operation convenience wrapper.
 */
import { asc, eq, inArray, and } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  operationDependencies,
  workOrderTasks,
  workOrders,
  items,
  materialRequirements,
  reservations,
  inventoryBalances,
  operationOutputs,
  dispositionRecords,
} from "@/db/schema";
import type { Exec } from "@/lib/inventory";

export type Blocker = {
  /**
   * SEQUENCE   — simply not this step's turn yet. Normal flow, not a problem.
   * DEPENDENCY — waiting on work happening somewhere else: a sub-assembly that has
   *              not delivered, or output under a quality hold. This is the one
   *              Thermal Corp loses time to.
   * MATERIAL   — waiting on purchased stock.
   *
   * The distinction matters: a supervisor who is shown every step that is merely
   * queued behind another cannot see the handful that are genuinely stuck.
   */
  kind: "SEQUENCE" | "DEPENDENCY" | "MATERIAL";
  /** Two or three words, for a chip in the UI. */
  label: string;
  /** One sentence naming what is missing and how much. */
  detail: string;
  /** Present on DEPENDENCY blockers, so the UI can link to the work being waited on. */
  sourceOperationId?: number;
  sourceOrderNumber?: string;
  sourceStationName?: string;
  /** Present on MATERIAL blockers. */
  itemSku?: string;
  shortBy?: number;
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Blockers for many operations in a fixed number of queries.
 * Operations with no entry in the returned map are ready to start.
 */
export async function blockersForOperations(
  operationIds: number[],
  exec: Exec = {}
): Promise<Map<number, Blocker[]>> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const out = new Map<number, Blocker[]>();
  if (operationIds.length === 0) return out;

  const add = (opId: number, b: Blocker) => {
    const list = out.get(opId);
    if (list) list.push(b);
    else out.set(opId, [b]);
  };

  // --- 1. Dependency records ------------------------------------------------
  const deps = await database
    .select()
    .from(operationDependencies)
    .where(inArray(operationDependencies.operationId, operationIds));

  const sourceIds = [
    ...new Set(deps.map((d) => d.dependsOnOperationId).filter((v): v is number => v !== null)),
  ];

  // Names, stations and order numbers for whatever is being waited on.
  const sources =
    sourceIds.length > 0
      ? await database
          .select({
            id: workOrderTasks.id,
            name: workOrderTasks.name,
            status: workOrderTasks.status,
            orderNumber: workOrders.orderNumber,
            itemName: items.name,
          })
          .from(workOrderTasks)
          .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
          .innerJoin(items, eq(workOrders.itemId, items.id))
          .where(inArray(workOrderTasks.id, sourceIds))
      : [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // Held quantities, for QUALITY_ACCEPTANCE.
  const outputs =
    sourceIds.length > 0
      ? await database
          .select()
          .from(operationOutputs)
          .where(inArray(operationOutputs.operationId, sourceIds))
      : [];
  const heldBySource = new Map(outputs.map((o) => [o.operationId, o.heldQty]));

  // Satisfied quantity per requirement, for REQUIRED_QUANTITY. Computed here in
  // one pass rather than calling satisfiedQuantityFor per dependency.
  const reqIdsForDeps = [
    ...new Set(deps.map((d) => d.requirementId).filter((v): v is number => v !== null)),
  ];
  /** Requirements a child work order supplies — the dependency owns the message. */
  const suppliedBySubAssembly = new Set(
    deps
      .filter((d) => d.type === "REQUIRED_QUANTITY" && d.requirementId !== null)
      .map((d) => d.requirementId as number)
  );
  const satisfiedByRequirement = await satisfiedQuantities(reqIdsForDeps, exec);

  for (const dep of deps) {
    const src = dep.dependsOnOperationId ? sourceById.get(dep.dependsOnOperationId) : undefined;

    if (dep.type === "FULL_COMPLETION") {
      if (src && src.status !== "DONE") {
        // A predecessor in the routing is always on the same work order, so naming
        // the unit again is noise. Only cross-order waits need the full address.
        add(dep.operationId, {
          kind: "SEQUENCE",
          label: "Earlier step",
          detail: `“${src.name}” is not finished`,
          sourceOperationId: src.id,
          sourceOrderNumber: src.orderNumber,
        });
      }
      continue;
    }

    if (dep.type === "REQUIRED_QUANTITY") {
      const need = dep.requiredQuantity ?? 0;
      const have = dep.requirementId ? (satisfiedByRequirement.get(dep.requirementId) ?? 0) : 0;
      if (have < need) {
        const shortBy = need - have;
        add(dep.operationId, {
          kind: "DEPENDENCY",
          label: "Sub-assembly",
          detail: src
            ? `Short ${plural(shortBy, "unit")} of ${src.itemName} — ${src.orderNumber} is at “${src.name}”`
            : `Short ${plural(shortBy, "unit")} of a sub-assembly this step needs`,
          sourceOperationId: src?.id,
          sourceOrderNumber: src?.orderNumber,
          shortBy,
        });
      }
      continue;
    }

    if (dep.type === "QUALITY_ACCEPTANCE") {
      const held = dep.dependsOnOperationId
        ? (heldBySource.get(dep.dependsOnOperationId) ?? 0)
        : 0;
      if (held > 0) {
        add(dep.operationId, {
          kind: "DEPENDENCY",
          label: "Quality hold",
          detail: src
            ? `${plural(held, "unit")} of ${src.itemName} from “${src.name}” is on a quality hold`
            : `A quality hold is open on the output this step needs`,
          sourceOperationId: src?.id,
          sourceOrderNumber: src?.orderNumber,
        });
      }
    }
  }

  // --- 2. Material ----------------------------------------------------------
  const reqs = await database
    .select({
      id: materialRequirements.id,
      operationId: materialRequirements.operationId,
      itemId: materialRequirements.itemId,
      requiredQty: materialRequirements.requiredQty,
      issuedQty: materialRequirements.issuedQty,
      returnedQty: materialRequirements.returnedQty,
      scrappedFromWipQty: materialRequirements.scrappedFromWipQty,
      sku: items.sku,
      itemName: items.name,
    })
    .from(materialRequirements)
    .innerJoin(items, eq(materialRequirements.itemId, items.id))
    .where(inArray(materialRequirements.operationId, operationIds));

  if (reqs.length > 0) {
    const reservedByRequirement = await reservedQuantities(
      reqs.map((r) => r.id),
      exec
    );
    // A requirement for a MANUFACTURED component is met by the sub-assembly's own
    // output — allocated or already installed — not by stock in a location. Without
    // this the same requirement is reported twice: once as a sub-assembly
    // dependency and again as a phantom stock shortage that no receipt can clear.
    const fromOutputs = await satisfiedQuantities(
      reqs.map((r) => r.id),
      exec
    );

    // Free stock per item across all locations. A station-scoped model would
    // narrow this; there is one stocking location today.
    const balances = await database
      .select()
      .from(inventoryBalances)
      .where(inArray(inventoryBalances.itemId, [...new Set(reqs.map((r) => r.itemId))]));
    const freeByItem = new Map<number, number>();
    for (const b of balances) {
      freeByItem.set(
        b.itemId,
        (freeByItem.get(b.itemId) ?? 0) + (b.onHand - b.activeReserved - b.heldQty)
      );
    }

    for (const r of reqs) {
      // A component built in-house is reported once, as a sub-assembly dependency.
      // Reporting it again as a stock shortage tells the worker to go and find
      // something that is not going to be in the racks.
      if (suppliedBySubAssembly.has(r.id)) continue;

      const netIssued = r.issuedQty - r.returnedQty - r.scrappedFromWipQty;
      const reserved = reservedByRequirement.get(r.id) ?? 0;
      const fromSubAssembly = fromOutputs.get(r.id) ?? 0;
      // What this step still has to obtain from somewhere.
      const outstanding = Math.max(
        0,
        r.requiredQty - netIssued - reserved - fromSubAssembly
      );
      if (outstanding === 0) continue;

      const free = freeByItem.get(r.itemId) ?? 0;
      const shortBy = outstanding - free;
      if (shortBy > 0) {
        add(r.operationId, {
          kind: "MATERIAL",
          label: "Material short",
          detail: `Short ${plural(shortBy, "unit")} of ${r.itemName} (${r.sku})`,
          itemSku: r.sku,
          shortBy,
        });
      }
    }
  }

  return out;
}

export async function blockersFor(operationId: number, exec: Exec = {}): Promise<Blocker[]> {
  const map = await blockersForOperations([operationId], exec);
  return map.get(operationId) ?? [];
}

export async function isReady(operationId: number, exec: Exec = {}): Promise<boolean> {
  return (await blockersFor(operationId, exec)).length === 0;
}

// ---------------------------------------------------------------------------
// Batched helpers
// ---------------------------------------------------------------------------

/**
 * `allocatedOutstanding(req) + netInstalledAgainst(req)` for many requirements,
 * derived from the append-only disposition history exactly as
 * `outputs.satisfiedQuantityFor` derives it for one.
 *
 * REJECT_INSTALLED deliberately does not reduce the total: a component rejected
 * while still installed keeps fulfilling the requirement physically, and the
 * parent is held instead (spec §2, §5).
 */
async function satisfiedQuantities(
  requirementIds: number[],
  exec: Exec = {}
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (requirementIds.length === 0) return result;
  const database = exec.tx ?? exec.db ?? defaultDb;

  const rows = await database
    .select()
    .from(dispositionRecords)
    .where(inArray(dispositionRecords.requirementId, requirementIds));

  const allocated = new Map<number, number>();
  const installed = new Map<number, number>();
  const bump = (m: Map<number, number>, k: number, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const r of rows) {
    const req = r.requirementId;
    if (req === null) continue;
    if (r.kind === "ALLOCATE") bump(allocated, req, r.quantity);
    if (r.kind === "DEALLOCATE") bump(allocated, req, -r.quantity);
    if (r.kind === "ISSUE_TO_PARENT") {
      bump(allocated, req, -r.quantity);
      bump(installed, req, r.quantity);
    }
    if (r.kind === "RETURN_FROM_PARENT") bump(installed, req, -r.quantity);
  }

  for (const id of requirementIds) {
    result.set(
      id,
      Math.max(0, allocated.get(id) ?? 0) + Math.max(0, installed.get(id) ?? 0)
    );
  }
  return result;
}

async function reservedQuantities(
  requirementIds: number[],
  exec: Exec = {}
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (requirementIds.length === 0) return result;
  const database = exec.tx ?? exec.db ?? defaultDb;

  const rows = await database
    .select()
    .from(reservations)
    .where(inArray(reservations.requirementId, requirementIds));

  for (const r of rows) {
    result.set(r.requirementId, (result.get(r.requirementId) ?? 0) + r.outstandingQty);
  }
  return result;
}

/**
 * Every operation currently waiting, newest demand first — the supervisor's
 * "what is stuck right now" question, answered in one query set.
 */
export type WaitingOperation = {
  operationId: number;
  operationName: string;
  workOrderId: number;
  stationName: string | null;
  orderNumber: string;
  itemName: string;
  level: number;
  dueDate: Date | null;
  blockers: Blocker[];
};

export async function waitingOperations(exec: Exec = {}): Promise<WaitingOperation[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  const open = await database
    .select({
      id: workOrderTasks.id,
      name: workOrderTasks.name,
      sequence: workOrderTasks.sequence,
      stationId: workOrderTasks.stationId,
      workOrderId: workOrderTasks.workOrderId,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      level: workOrders.level,
      dueDate: workOrders.dueDate,
    })
    .from(workOrderTasks)
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .where(
      and(
        inArray(workOrderTasks.status, ["PENDING", "BLOCKED"]),
        inArray(workOrders.status, ["RELEASED", "IN_PROGRESS"])
      )
    );

  if (open.length === 0) return [];

  const blockers = await blockersForOperations(
    open.map((o) => o.id),
    exec
  );

  const { stations } = await import("@/db/schema");
  const stationRows = await database.select().from(stations);
  const stationName = new Map(stationRows.map((s) => [s.id, s.name]));

  return open
    .filter((o) => (blockers.get(o.id) ?? []).length > 0)
    .map((o) => ({
      operationId: o.id,
      operationName: o.name,
      workOrderId: o.workOrderId,
      stationName: o.stationId ? (stationName.get(o.stationId) ?? null) : null,
      orderNumber: o.orderNumber,
      itemName: o.itemName,
      level: o.level,
      dueDate: o.dueDate,
      blockers: blockers.get(o.id) ?? [],
    }))
    .sort(
      (a, b) =>
        (a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.level - b.level
    );
}

/**
 * How far along the work somebody is waiting on has got.
 *
 * "Short 1 Welded Casing Frame" tells an operator they cannot start. It does not
 * tell them whether that frame is one step away or five, which is the difference
 * between waiting at the bench and going to do something else. This answers that,
 * for the orders behind a set of blockers.
 */
export type UpstreamProgress = {
  orderId: number;
  orderNumber: string;
  done: number;
  total: number;
  /** The step it is on now, or null when every step is finished. */
  currentStep: string | null;
};

export async function upstreamProgressFor(
  operationIds: number[],
  exec: Exec = {}
): Promise<Map<number, UpstreamProgress>> {
  const out = new Map<number, UpstreamProgress>();
  if (operationIds.length === 0) return out;
  const database = exec.tx ?? exec.db ?? defaultDb;

  // Which order each source step belongs to.
  const sources = await database
    .select({
      operationId: workOrderTasks.id,
      workOrderId: workOrderTasks.workOrderId,
      orderNumber: workOrders.orderNumber,
    })
    .from(workOrderTasks)
    .innerJoin(workOrders, eq(workOrders.id, workOrderTasks.workOrderId))
    .where(inArray(workOrderTasks.id, operationIds));
  if (sources.length === 0) return out;

  const orderIds = [...new Set(sources.map((s) => s.workOrderId))];
  const siblings = await database
    .select({
      workOrderId: workOrderTasks.workOrderId,
      name: workOrderTasks.name,
      status: workOrderTasks.status,
      sequence: workOrderTasks.sequence,
    })
    .from(workOrderTasks)
    .where(inArray(workOrderTasks.workOrderId, orderIds))
    .orderBy(asc(workOrderTasks.sequence));

  for (const source of sources) {
    const steps = siblings.filter((s) => s.workOrderId === source.workOrderId);
    const done = steps.filter((s) => s.status === "DONE").length;
    out.set(source.operationId, {
      orderId: source.workOrderId,
      orderNumber: source.orderNumber,
      done,
      total: steps.length,
      currentStep: steps.find((s) => s.status !== "DONE")?.name ?? null,
    });
  }
  return out;
}
