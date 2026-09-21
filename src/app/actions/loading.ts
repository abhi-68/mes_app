"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { deliveryNotes, workOrders } from "@/db/schema";
import { requireRole } from "@/lib/session";
import { CommandError } from "@/lib/inventory";
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
      return number;
    });

    revalidatePath("/", "layout");
    return { ok: true, noteNumber };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not record that. Please try again." };
  }
}
