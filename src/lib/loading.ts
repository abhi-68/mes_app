import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers, deliveryNotes, inventoryBalances, inventoryMovements, items, stockLots, users,
  workOrders,
} from "@/db/schema";

/**
 * What is built and waiting to go on a truck.
 *
 * Finished units are received into stock when their last step is signed off, so
 * this reads the racks rather than the work orders: the forklift driver is looking
 * for a physical thing on a pallet, and "the order is complete" is not the same
 * claim as "it is on the floor with a label on it".
 */

export type LoadableUnit = {
  lotId: number;
  batchNumber: string;
  itemName: string;
  sku: string;
  unit: string;
  quantity: number;
  storageLocation: string | null;
  orderId: number | null;
  orderNumber: string | null;
  customerName: string | null;
  /** The note it belongs to, once one has been raised for it. */
  noteId: number | null;
  noteNumber: string | null;
  noteStatus: string | null;
};

export async function loadableUnits(): Promise<LoadableUnit[]> {
  // Finished goods only: raw stock is not something anybody loads onto a truck.
  const lots = await db
    .select({
      lotId: stockLots.id,
      batchNumber: stockLots.batchNumber,
      storageLocation: stockLots.storageLocation,
      itemName: items.name,
      sku: items.sku,
      unit: items.unitOfMeasure,
      itemId: items.id,
      remaining: sql<number>`coalesce((
        select sum(m.quantity) from ${inventoryMovements} m where m.lot_id = ${stockLots.id}
      ), 0)::int`,
    })
    .from(stockLots)
    .innerJoin(items, eq(items.id, stockLots.itemId))
    .where(eq(items.isFinishedGood, true))
    .orderBy(desc(stockLots.id));

  const withStock = lots.filter((l) => l.remaining > 0 && l.batchNumber);
  if (withStock.length === 0) return [];

  // A finished unit's batch number IS its order number, set when it was received.
  const numbers = withStock.map((l) => l.batchNumber!).filter(Boolean);
  const orders = numbers.length
    ? await db
        .select({
          id: workOrders.id,
          orderNumber: workOrders.orderNumber,
          customerName: customers.name,
        })
        .from(workOrders)
        .leftJoin(customers, eq(customers.id, workOrders.customerId))
        .where(inArray(workOrders.orderNumber, numbers))
    : [];
  const orderByNumber = new Map(orders.map((o) => [o.orderNumber, o]));

  const notes = orders.length
    ? await db
        .select({
          id: deliveryNotes.id,
          noteNumber: deliveryNotes.noteNumber,
          status: sql<string>`${deliveryNotes.status}::text`,
          workOrderId: deliveryNotes.workOrderId,
        })
        .from(deliveryNotes)
        .where(inArray(deliveryNotes.workOrderId, orders.map((o) => o.id)))
        .orderBy(asc(deliveryNotes.id))
    : [];
  const noteByOrder = new Map(notes.map((n) => [n.workOrderId, n]));

  return withStock.map((l) => {
    const order = orderByNumber.get(l.batchNumber!);
    const note = order ? noteByOrder.get(order.id) : undefined;
    return {
      lotId: l.lotId,
      batchNumber: l.batchNumber!,
      itemName: l.itemName,
      sku: l.sku,
      unit: l.unit,
      quantity: l.remaining,
      storageLocation: l.storageLocation,
      orderId: order?.id ?? null,
      orderNumber: order?.orderNumber ?? null,
      customerName: order?.customerName ?? null,
      noteId: note?.id ?? null,
      noteNumber: note?.noteNumber ?? null,
      noteStatus: note?.status ?? null,
    };
  });
}

export type LoadedRecord = {
  noteNumber: string;
  orderNumber: string;
  quantity: number;
  handlerName: string | null;
  at: Date | null;
};

/** What has gone on a truck, for the supervisor's side of the same fact. */
export async function recentlyLoaded(limit = 10): Promise<LoadedRecord[]> {
  return db
    .select({
      noteNumber: deliveryNotes.noteNumber,
      orderNumber: workOrders.orderNumber,
      quantity: deliveryNotes.quantity,
      handlerName: users.name,
      at: deliveryNotes.pickedUpAt,
    })
    .from(deliveryNotes)
    .innerJoin(workOrders, eq(workOrders.id, deliveryNotes.workOrderId))
    .leftJoin(users, eq(users.id, deliveryNotes.handlerUserId))
    .where(inArray(deliveryNotes.status, ["PICKED_UP", "DELIVERED"]))
    .orderBy(desc(deliveryNotes.id))
    .limit(limit);
}

/** Finished stock on the racks, for the supervisor's dispatch screen. */
export async function finishedGoodsOnHand(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${inventoryBalances.onHand}), 0)::int` })
    .from(inventoryBalances)
    .innerJoin(items, eq(items.id, inventoryBalances.itemId))
    .where(and(eq(items.isFinishedGood, true), gt(inventoryBalances.onHand, 0)));
  return row?.n ?? 0;
}
