import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dispositionRecords, items, operationDependencies, operationOutputs, stations, users,
  workOrders, workOrderTasks,
} from "@/db/schema";
import { satisfiedQuantityFor } from "@/lib/outputs";

/**
 * The inspection queue.
 *
 * The output engine — produce, inspect, accept, rework, scrap, hold — was built and
 * tested long before this file, and no screen called any of it. With
 * `items.requiresInspection` now enforced, work genuinely stops here, so this is
 * the screen that lets it move again.
 */

export type InspectionItem = {
  operationId: number;
  operationName: string;
  orderId: number;
  orderNumber: string;
  itemName: string;
  sku: string;
  stationName: string | null;
  pendingInspection: number;
  awaitingRework: number;
  accepted: number;
  scrapped: number;
  /** The requirement this output was made for, if anything is waiting on it. */
  requirementId: number | null;
  requiredQuantity: number | null;
  satisfied: number;
  /** Who is held up while this sits here. */
  waitingOperationName: string | null;
  waitingOrderNumber: string | null;
};

export async function inspectionQueue(): Promise<InspectionItem[]> {
  const rows = await db
    .select({
      operationId: operationOutputs.operationId,
      pendingInspection: operationOutputs.pendingInspection,
      awaitingRework: operationOutputs.awaitingRework,
      accepted: operationOutputs.accepted,
      scrapped: operationOutputs.scrapped,
      operationName: workOrderTasks.name,
      orderId: workOrders.id,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      sku: items.sku,
      stationName: stations.name,
    })
    .from(operationOutputs)
    .innerJoin(workOrderTasks, eq(operationOutputs.operationId, workOrderTasks.id))
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .leftJoin(stations, eq(workOrderTasks.stationId, stations.id))
    .where(
      or(gt(operationOutputs.pendingInspection, 0), gt(operationOutputs.awaitingRework, 0))
    )
    .orderBy(asc(workOrders.dueDate), asc(workOrders.id));

  if (rows.length === 0) return [];

  // What is waiting on each of these, so the inspector can see the cost of the queue.
  const deps = await db
    .select({
      dependsOn: operationDependencies.dependsOnOperationId,
      requirementId: operationDependencies.requirementId,
      requiredQuantity: operationDependencies.requiredQuantity,
      waitingOperationName: workOrderTasks.name,
      waitingOrderNumber: workOrders.orderNumber,
    })
    .from(operationDependencies)
    .innerJoin(workOrderTasks, eq(operationDependencies.operationId, workOrderTasks.id))
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .where(eq(operationDependencies.type, "REQUIRED_QUANTITY"));

  const depOf = new Map(deps.filter((d) => d.dependsOn !== null).map((d) => [d.dependsOn!, d]));

  return Promise.all(
    rows.map(async (r) => {
      const dep = depOf.get(r.operationId);
      return {
        ...r,
        requirementId: dep?.requirementId ?? null,
        requiredQuantity: dep?.requiredQuantity ?? null,
        satisfied: dep?.requirementId ? await satisfiedQuantityFor(dep.requirementId) : 0,
        waitingOperationName: dep?.waitingOperationName ?? null,
        waitingOrderNumber: dep?.waitingOrderNumber ?? null,
      };
    })
  );
}

export type QualityEvent = {
  id: number;
  kind: string;
  quantity: number;
  reason: string | null;
  actorName: string | null;
  createdAt: Date;
  itemName: string;
  orderNumber: string;
  operationName: string;
};

/** Recent dispositions — the audit trail, so a pass or a scrap has a name on it. */
export async function recentDispositions(limit = 25): Promise<QualityEvent[]> {
  return db
    .select({
      id: dispositionRecords.id,
      kind: sql<string>`${dispositionRecords.kind}::text`,
      quantity: dispositionRecords.quantity,
      reason: dispositionRecords.reason,
      actorName: users.name,
      createdAt: dispositionRecords.createdAt,
      itemName: items.name,
      orderNumber: workOrders.orderNumber,
      operationName: workOrderTasks.name,
    })
    .from(dispositionRecords)
    .innerJoin(workOrderTasks, eq(dispositionRecords.operationId, workOrderTasks.id))
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .leftJoin(users, eq(dispositionRecords.actorUserId, users.id))
    .orderBy(desc(dispositionRecords.id))
    .limit(limit);
}

export type QualitySummary = {
  awaitingInspection: number;
  awaitingRework: number;
  acceptedToday: number;
  scrappedToday: number;
};

export async function qualitySummary(): Promise<QualitySummary> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const [queue] = await db
    .select({
      pending: sql<number>`coalesce(sum(${operationOutputs.pendingInspection}), 0)::int`,
      rework: sql<number>`coalesce(sum(${operationOutputs.awaitingRework}), 0)::int`,
    })
    .from(operationOutputs);

  const today = await db
    .select({
      kind: sql<string>`${dispositionRecords.kind}::text`,
      n: sql<number>`coalesce(sum(${dispositionRecords.quantity}), 0)::int`,
    })
    .from(dispositionRecords)
    .where(and(gt(dispositionRecords.createdAt, midnight)))
    .groupBy(dispositionRecords.kind);

  const of = (kind: string) => today.find((t) => t.kind === kind)?.n ?? 0;
  return {
    awaitingInspection: queue?.pending ?? 0,
    awaitingRework: queue?.rework ?? 0,
    acceptedToday: of("ACCEPT"),
    scrappedToday: of("SCRAP"),
  };
}
