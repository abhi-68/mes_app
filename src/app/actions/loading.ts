"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { deliveryNotes, inventoryBalances, stockLots, workOrders } from "@/db/schema";
import { requireRole } from "@/lib/session";
import { CommandError, shipFinishedGoods } from "@/lib/inventory";
import { advanceDeliveryNote, createDeliveryNote } from "@/lib/delivery";

const request = z.object({ orderId: z.number().int().positive() }).strict();

/**
 * "It is on the truck."
 *
 * One press, and the driver should not have to think about delivery notes. So
 * this raises one if nobody has, names them as the handler, and moves it to
 * picked up — the three steps a supervisor would otherwise do on their behalf,
 * in the order they would do them.
 *
 * The supervisor's dispatch screen reads the same rows, so it reflects there the
 * moment this returns.
 */
export async function markLoaded(
  input: z.infer<typeof request>
): Promise<{ ok: true; noteNumber: string } | { ok: false; error: string }> {
  try {
    const user = await requireRole("FORKLIFT", "SUPERVISOR", "ADMIN");
    const parsed = request.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Pick something to load" };
    const { orderId } = parsed.data;

    const [order] = await db.select().from(workOrders).where(eq(workOrders.id, orderId));
    if (!order) return { ok: false, error: "That order does not exist" };

    const noteNumber = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(deliveryNotes)
        .where(
          and(eq(deliveryNotes.workOrderId, orderId), ne(deliveryNotes.status, "CANCELLED"))
        )
        .orderBy(sql`id asc`)
        .limit(1);

      let noteId: number;
      let number: string;
      if (existing) {
        noteId = existing.id;
        number = existing.noteNumber;
      } else {
        const made = await createDeliveryNote(
          {
            workOrderId: orderId,
            quantity: order.quantity,
            handlerUserId: user.id,
            actorUserId: user.id,
          },
          { tx }
        );
        noteId = made.id;
        number = made.noteNumber;
      }

      // Walk it forward to picked up, whichever step it was sitting on.
      const [note] = await tx.select().from(deliveryNotes).where(eq(deliveryNotes.id, noteId));
      if (note.status === "UNASSIGNED") {
        await advanceDeliveryNote(
          { noteId, to: "ALLOCATED", handlerUserId: user.id, actorUserId: user.id },
          { tx }
        );
      }
      const [again] = await tx.select().from(deliveryNotes).where(eq(deliveryNotes.id, noteId));
      if (again.status === "ALLOCATED") {
        await advanceDeliveryNote(
          { noteId, to: "PICKED_UP", handlerUserId: user.id, actorUserId: user.id },
          { tx }
        );
      }

      // The factory finished it; it is now somewhere between here and the
      // customer. Only the person who takes the call saying it arrived can say
      // shipped, so this stops one step short of that.
      await tx
        .update(workOrders)
        .set({ status: "IN_TRANSIT" })
        .where(eq(workOrders.id, orderId));

      // It is on a truck, so it is off the rack. The batch is the order number.
      const [lot] = await tx
        .select({ id: stockLots.id, locationId: inventoryBalances.locationId })
        .from(stockLots)
        .innerJoin(inventoryBalances, eq(inventoryBalances.itemId, stockLots.itemId))
        .where(eq(stockLots.batchNumber, order.orderNumber))
        .limit(1);
      if (lot) {
        await shipFinishedGoods(
          {
            commandId: `ship:${orderId}`,
            itemId: order.itemId,
            locationId: lot.locationId,
            quantity: order.quantity,
            lotId: lot.id,
            actorUserId: user.id,
          },
          { tx }
        );
      }

      return number;
    });

    revalidatePath("/", "layout");
    return { ok: true, noteNumber };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not record that. Please try again." };
  }
}

/**
 * "The customer has it."
 *
 * A supervisor's confirmation, not a driver's: it is true when somebody rings to
 * say the machine arrived, which happens long after the truck left and cannot be
 * known by anyone on the yard.
 */
export async function markShipped(
  input: z.infer<typeof request>
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await requireRole("SUPERVISOR", "ADMIN");
    const parsed = request.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Pick an order" };
    const { orderId } = parsed.data;

    const [order] = await db.select().from(workOrders).where(eq(workOrders.id, orderId));
    if (!order) return { ok: false, error: "That order does not exist" };
    if (order.status === "SHIPPED") return { ok: true };
    if (order.status !== "IN_TRANSIT" && order.status !== "DONE") {
      return { ok: false, error: "That order has not been built and loaded yet" };
    }

    await db.transaction(async (tx) => {
      await tx.update(workOrders).set({ status: "SHIPPED" }).where(eq(workOrders.id, orderId));

      const [note] = await tx
        .select()
        .from(deliveryNotes)
        .where(
          and(eq(deliveryNotes.workOrderId, orderId), ne(deliveryNotes.status, "CANCELLED"))
        )
        .orderBy(sql`id asc`)
        .limit(1);
      if (note && note.status === "PICKED_UP") {
        await advanceDeliveryNote(
          { noteId: note.id, to: "DELIVERED", actorUserId: user.id },
          { tx }
        );
      }
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not record that. Please try again." };
  }
}
