import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, deliveryNotes, items, users, workOrders, workOrderTasks } from "@/db/schema";
import { CommandError, type Exec } from "@/lib/inventory";
import { nextDocumentNumber } from "@/lib/numbering";

/**
 * Dispatch.
 *
 * Two rules do the real work here.
 *
 * 1. You cannot promise more than you built. The quantity available to ship is the
 *    order quantity less everything already on a live note, computed under a row
 *    lock on the order — otherwise two people raise notes for the last unit at the
 *    same moment and both succeed.
 * 2. Status only moves forward. A note that has been delivered is a statement about
 *    something that happened; letting it slide back to PICKED_UP would make the
 *    record a worse witness than the paper it replaces. Cancelling is a separate
 *    move, and only before the goods leave.
 */

export const DELIVERY_FLOW = ["UNASSIGNED", "ALLOCATED", "PICKED_UP", "DELIVERED"] as const;
export type DeliveryStatus = (typeof DELIVERY_FLOW)[number] | "CANCELLED";

const OPEN_STATUSES = ["UNASSIGNED", "ALLOCATED", "PICKED_UP", "DELIVERED"] as const;

export function nextDeliveryNoteNumber(exec: Exec = {}): Promise<string> {
  return nextDocumentNumber("DN", "delivery_notes", "note_number", exec);
}

export type DeliveryRow = {
  id: number;
  noteNumber: string;
  status: DeliveryStatus;
  quantity: number;
  orderId: number;
  orderNumber: string;
  itemName: string;
  customerName: string | null;
  handlerName: string | null;
  notes: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
};

export async function deliveryNoteList(status?: string): Promise<DeliveryRow[]> {
  const rows = await db
    .select({
      id: deliveryNotes.id,
      noteNumber: deliveryNotes.noteNumber,
      status: sql<DeliveryStatus>`${deliveryNotes.status}::text`,
      quantity: deliveryNotes.quantity,
      orderId: workOrders.id,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      customerName: customers.name,
      handlerName: users.name,
      notes: deliveryNotes.notes,
      createdAt: deliveryNotes.createdAt,
      deliveredAt: deliveryNotes.deliveredAt,
    })
    .from(deliveryNotes)
    .innerJoin(workOrders, eq(deliveryNotes.workOrderId, workOrders.id))
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .leftJoin(users, eq(deliveryNotes.handlerUserId, users.id))
    .orderBy(desc(deliveryNotes.id));

  return status && status !== "all" ? rows.filter((r) => r.status === status) : rows;
}

export type ShippableOrder = {
  orderId: number;
  orderNumber: string;
  itemName: string;
  customerName: string | null;
  quantity: number;
  promised: number;
  remaining: number;
  stepsOutstanding: number;
};

/** Top-level orders with something left to ship. */
export async function shippableOrders(): Promise<ShippableOrder[]> {
  const orders = await db
    .select({
      orderId: workOrders.id,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      customerName: customers.name,
      quantity: workOrders.quantity,
    })
    .from(workOrders)
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .where(
      and(
        sql`${workOrders.parentWorkOrderId} is null`,
        inArray(workOrders.status, ["RELEASED", "IN_PROGRESS", "DONE"])
      )
    )
    .orderBy(workOrders.id);
  if (orders.length === 0) return [];

  const ids = orders.map((o) => o.orderId);
  const [promised, outstanding] = await Promise.all([
    db
      .select({
        workOrderId: deliveryNotes.workOrderId,
        n: sql<number>`coalesce(sum(${deliveryNotes.quantity}), 0)::int`,
      })
      .from(deliveryNotes)
      .where(
        and(inArray(deliveryNotes.workOrderId, ids), ne(deliveryNotes.status, "CANCELLED"))
      )
      .groupBy(deliveryNotes.workOrderId),
    db
      .select({
        workOrderId: workOrderTasks.workOrderId,
        n: sql<number>`count(*)::int`,
      })
      .from(workOrderTasks)
      .where(and(inArray(workOrderTasks.workOrderId, ids), ne(workOrderTasks.status, "DONE")))
      .groupBy(workOrderTasks.workOrderId),
  ]);

  const promisedOf = new Map(promised.map((p) => [p.workOrderId, p.n]));
  const outstandingOf = new Map(outstanding.map((o) => [o.workOrderId, o.n]));

  return orders
    .map((o) => {
      const p = promisedOf.get(o.orderId) ?? 0;
      return {
        ...o,
        promised: p,
        remaining: Math.max(0, o.quantity - p),
        stepsOutstanding: outstandingOf.get(o.orderId) ?? 0,
      };
    })
    .filter((o) => o.remaining > 0);
}

/** How much of an order is not yet on a live note. Call inside the transaction. */
export async function remainingToShip(
  workOrderId: number,
  exec: Exec = {}
): Promise<{ quantity: number; promised: number; remaining: number }> {
  const database = exec.tx ?? exec.db ?? db;
  const [order] = await database
    .select({ quantity: workOrders.quantity })
    .from(workOrders)
    .where(eq(workOrders.id, workOrderId));
  if (!order) throw new CommandError("Work order not found", "NOT_FOUND");

  const [row] = await database
    .select({ n: sql<number>`coalesce(sum(${deliveryNotes.quantity}), 0)::int` })
    .from(deliveryNotes)
    .where(
      and(eq(deliveryNotes.workOrderId, workOrderId), ne(deliveryNotes.status, "CANCELLED"))
    );
  const promised = row?.n ?? 0;
  return { quantity: order.quantity, promised, remaining: Math.max(0, order.quantity - promised) };
}

export async function createDeliveryNote(
  input: {
    workOrderId: number;
    quantity: number;
    handlerUserId: number | null;
    notes?: string | null;
    actorUserId: number;
  },
  exec: Exec = {}
): Promise<{ id: number; noteNumber: string }> {
  const database = exec.db ?? db;
  const perform = async (tx: NonNullable<Exec["tx"]>) => {
    if (input.quantity < 1) throw new CommandError("Quantity must be at least 1", "STATE_GUARD");

    // Lock the order so the remaining quantity cannot be read by two callers at
    // once and promised twice.
    const [order] = await tx
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, input.workOrderId))
      .for("update");
    if (!order) throw new CommandError("Work order not found", "NOT_FOUND");
    if (order.status === "CANCELLED") {
      throw new CommandError("That order was cancelled", "STATE_GUARD");
    }

    const { remaining } = await remainingToShip(input.workOrderId, { tx });
    if (remaining <= 0) {
      throw new CommandError("Everything on this order is already on a delivery note", "STATE_GUARD");
    }
    if (input.quantity > remaining) {
      throw new CommandError(
        `Only ${remaining} left to ship on this order`,
        "STATE_GUARD"
      );
    }

    const noteNumber = await nextDeliveryNoteNumber({ tx });
    const [row] = await tx
      .insert(deliveryNotes)
      .values({
        noteNumber,
        workOrderId: input.workOrderId,
        quantity: input.quantity,
        // Naming a handler at the moment of writing is what "allocated" means.
        status: input.handlerUserId ? "ALLOCATED" : "UNASSIGNED",
        handlerUserId: input.handlerUserId,
        createdByUserId: input.actorUserId,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: deliveryNotes.id, noteNumber: deliveryNotes.noteNumber });
    return row;
  };
  return exec.tx ? perform(exec.tx) : database.transaction(perform);
}

export async function advanceDeliveryNote(
  input: { noteId: number; to: DeliveryStatus; handlerUserId?: number | null; actorUserId: number },
  exec: Exec = {}
): Promise<void> {
  const database = exec.db ?? db;
  const perform = async (tx: NonNullable<Exec["tx"]>) => {
    const [note] = await tx
      .select()
      .from(deliveryNotes)
      .where(eq(deliveryNotes.id, input.noteId))
      .for("update");
    if (!note) throw new CommandError("Delivery note not found", "NOT_FOUND");

    const current = note.status as DeliveryStatus;
    if (current === "DELIVERED") {
      throw new CommandError("That note is already delivered", "STATE_GUARD");
    }
    if (current === "CANCELLED") {
      throw new CommandError("That note was cancelled", "STATE_GUARD");
    }

    if (input.to === "CANCELLED") {
      if (current === "PICKED_UP") {
        throw new CommandError(
          "It has already left — record it as delivered rather than cancelling it",
          "STATE_GUARD"
        );
      }
    } else {
      const from = DELIVERY_FLOW.indexOf(current as (typeof DELIVERY_FLOW)[number]);
      const to = DELIVERY_FLOW.indexOf(input.to as (typeof DELIVERY_FLOW)[number]);
      if (to < 0) throw new CommandError("Unknown delivery status", "STATE_GUARD");
      if (to <= from) {
        throw new CommandError("A delivery note only moves forward", "STATE_GUARD");
      }
      if (to > from + 1) {
        throw new CommandError(
          `It has to go through ${DELIVERY_FLOW[from + 1].toLowerCase().replace("_", " ")} first`,
          "STATE_GUARD"
        );
      }
      // Nobody carries a parcel anonymously.
      const handler = input.handlerUserId ?? note.handlerUserId;
      if (input.to !== "UNASSIGNED" && !handler) {
        throw new CommandError("Name who is handling it first", "STATE_GUARD");
      }
    }

    await tx
      .update(deliveryNotes)
      .set({
        status: input.to,
        handlerUserId: input.handlerUserId ?? note.handlerUserId,
        pickedUpAt: input.to === "PICKED_UP" ? new Date() : note.pickedUpAt,
        deliveredAt: input.to === "DELIVERED" ? new Date() : note.deliveredAt,
      })
      .where(eq(deliveryNotes.id, input.noteId));
  };
  return exec.tx ? perform(exec.tx) : database.transaction(perform);
}

export type DeliverySummary = {
  open: number;
  inTransit: number;
  deliveredToday: number;
  unassigned: number;
};

export async function deliverySummary(): Promise<DeliverySummary> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      status: sql<string>`${deliveryNotes.status}::text`,
      n: sql<number>`count(*)::int`,
      deliveredToday: sql<number>`count(*) filter (where ${deliveryNotes.deliveredAt} >= ${midnight})::int`,
    })
    .from(deliveryNotes)
    .where(inArray(deliveryNotes.status, [...OPEN_STATUSES]))
    .groupBy(deliveryNotes.status);

  const of = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return {
    open: of("UNASSIGNED") + of("ALLOCATED") + of("PICKED_UP"),
    inTransit: of("PICKED_UP"),
    deliveredToday: rows.reduce((n, r) => n + (r.status === "DELIVERED" ? r.deliveredToday : 0), 0),
    unassigned: of("UNASSIGNED"),
  };
}
