import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers, deliveryNotes, dispositionRecords, inventoryMovements, items, stations,
  stockLots, users, workOrders, workOrderTasks,
} from "@/db/schema";

/**
 * The production report for one order — what was built, from what, by whom.
 *
 * This is the document a customer quality query becomes: which heats of steel went
 * into serial 4471, who signed the step off, what was rejected on the way and what
 * finally left the building. It is assembled from the ledger rather than typed up
 * afterwards, which is the only version of this document worth having.
 *
 * Where a lot was inferred rather than scanned it says so. A trace that cannot
 * distinguish "this heat" from "probably this heat" will be believed, and that is
 * worse than one that admits the gap.
 */

export type ReportStep = {
  sequence: number;
  name: string;
  stationName: string | null;
  status: string;
  completedBy: string | null;
  completedAt: Date | null;
  /** Charged time in minutes, shared where one person ran two machines. */
  minutes: number;
  expectedMinutes: number | null;
};

export type ReportMaterial = {
  itemName: string;
  sku: string;
  unit: string;
  quantity: number;
  batchNumber: string | null;
  heatNumber: string | null;
  vendorName: string | null;
  assumed: boolean;
  stepName: string;
};

export type ReportQuality = {
  kind: string;
  quantity: number;
  reason: string | null;
  actorName: string | null;
  at: Date;
  stepName: string;
};

export type ReportShipment = {
  noteNumber: string;
  quantity: number;
  status: string;
  handlerName: string | null;
  deliveredAt: Date | null;
};

export type ProductionReport = {
  orderNumber: string;
  itemName: string;
  sku: string;
  customerName: string | null;
  quantity: number;
  status: string;
  dueDate: Date | null;
  createdAt: Date;
  steps: ReportStep[];
  totalMinutes: number;
  expectedMinutes: number;
  subAssemblies: { orderNumber: string; itemName: string; status: string }[];
  materials: ReportMaterial[];
  quality: ReportQuality[];
  shipments: ReportShipment[];
  untracedIssues: number;
};

export async function productionReport(workOrderId: number): Promise<ProductionReport | null> {
  const [order] = await db
    .select({
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      sku: items.sku,
      customerName: customers.name,
      quantity: workOrders.quantity,
      status: sql<string>`${workOrders.status}::text`,
      dueDate: workOrders.dueDate,
      createdAt: workOrders.createdAt,
    })
    .from(workOrders)
    .innerJoin(items, eq(items.id, workOrders.itemId))
    .leftJoin(customers, eq(customers.id, workOrders.customerId))
    .where(eq(workOrders.id, workOrderId));
  if (!order) return null;

  // The order and everything built for it: a report that stopped at the parent
  // would omit the sub-assembly that actually consumed the steel.
  const children = await db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      status: sql<string>`${workOrders.status}::text`,
    })
    .from(workOrders)
    .innerJoin(items, eq(items.id, workOrders.itemId))
    .where(eq(workOrders.parentWorkOrderId, workOrderId))
    .orderBy(asc(workOrders.id));

  const orderIds = [workOrderId, ...children.map((c) => c.id)];

  const steps = await db
    .select({
      id: workOrderTasks.id,
      sequence: workOrderTasks.sequence,
      name: workOrderTasks.name,
      stationName: stations.name,
      expectedMinutes: workOrderTasks.expectedMinutes,
      minutes: sql<number>`coalesce((
        select round(sum(te.duration_seconds) / 60.0)
        from time_entries te where te.work_order_task_id = ${workOrderTasks.id}
      ), 0)::int`,
      status: sql<string>`${workOrderTasks.status}::text`,
      completedBy: users.name,
      completedAt: workOrderTasks.completedAt,
      workOrderId: workOrderTasks.workOrderId,
    })
    .from(workOrderTasks)
    .leftJoin(users, eq(users.id, workOrderTasks.completedByUserId))
    .leftJoin(stations, eq(stations.id, workOrderTasks.stationId))
    .where(inArray(workOrderTasks.workOrderId, orderIds))
    .orderBy(asc(workOrderTasks.workOrderId), asc(workOrderTasks.sequence));

  const stepName = new Map(steps.map((s) => [s.id, s.name]));
  const stepIds = steps.map((s) => s.id);

  // Every issue against this order's steps, with the batch behind it.
  const materials = stepIds.length
    ? await db
        .select({
          quantity: inventoryMovements.quantity,
          assumed: inventoryMovements.lotAssumed,
          operationId: sql<number>`coalesce(
            (select operation_id from material_requirements mr
              where mr.id = ${inventoryMovements.requirementId}), 0)`,
          itemName: items.name,
          sku: items.sku,
          unit: items.unitOfMeasure,
          batchNumber: stockLots.batchNumber,
          heatNumber: stockLots.heatNumber,
          vendorName: sql<string | null>`null`,
        })
        .from(inventoryMovements)
        .innerJoin(items, eq(items.id, inventoryMovements.itemId))
        .leftJoin(stockLots, eq(stockLots.id, inventoryMovements.lotId))
        .where(
          and(
            eq(inventoryMovements.type, "ISSUE"),
            sql`(select operation_id from material_requirements mr
                  where mr.id = ${inventoryMovements.requirementId}) = any(${sql.raw(
                    `ARRAY[${stepIds.join(",")}]`
                  )})`
          )
        )
    : [];

  const quality = stepIds.length
    ? await db
        .select({
          kind: sql<string>`${dispositionRecords.kind}::text`,
          quantity: dispositionRecords.quantity,
          reason: dispositionRecords.reason,
          actorName: users.name,
          at: dispositionRecords.createdAt,
          operationId: dispositionRecords.operationId,
        })
        .from(dispositionRecords)
        .leftJoin(users, eq(users.id, dispositionRecords.actorUserId))
        .where(inArray(dispositionRecords.operationId, stepIds))
        .orderBy(asc(dispositionRecords.id))
    : [];

  const shipments = await db
    .select({
      noteNumber: deliveryNotes.noteNumber,
      quantity: deliveryNotes.quantity,
      status: sql<string>`${deliveryNotes.status}::text`,
      handlerName: users.name,
      deliveredAt: deliveryNotes.deliveredAt,
    })
    .from(deliveryNotes)
    .leftJoin(users, eq(users.id, deliveryNotes.handlerUserId))
    .where(eq(deliveryNotes.workOrderId, workOrderId))
    .orderBy(asc(deliveryNotes.id));

  return {
    ...order,
    steps: steps.map((s) => ({
      sequence: s.sequence,
      name: s.name,
      stationName: s.stationName,
      status: s.status,
      completedBy: s.completedBy,
      completedAt: s.completedAt,
      minutes: s.minutes,
      expectedMinutes: s.expectedMinutes,
    })),
    totalMinutes: steps.reduce((n, s) => n + s.minutes, 0),
    expectedMinutes: steps.reduce((n, s) => n + (s.expectedMinutes ?? 0), 0),
    subAssemblies: children.map((c) => ({
      orderNumber: c.orderNumber,
      itemName: c.itemName,
      status: c.status,
    })),
    materials: materials.map((m) => ({
      itemName: m.itemName,
      sku: m.sku,
      unit: m.unit,
      quantity: Math.abs(m.quantity),
      batchNumber: m.batchNumber,
      heatNumber: m.heatNumber,
      vendorName: m.vendorName,
      assumed: m.assumed,
      stepName: stepName.get(m.operationId) ?? "—",
    })),
    quality: quality.map((q) => ({
      kind: q.kind,
      quantity: q.quantity,
      reason: q.reason,
      actorName: q.actorName,
      at: q.at,
      stepName: stepName.get(q.operationId) ?? "—",
    })),
    shipments,
    untracedIssues: materials.filter((m) => m.batchNumber === null).length,
  };
}
