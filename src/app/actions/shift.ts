"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { timeEntries } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { shiftSummaryFor, type ShiftSummary } from "@/lib/shift";

/**
 * End of shift: stop anything still running, then say what got done.
 *
 * Clocking off matters even though no clock is shown. A step left running
 * overnight is what makes one operator appear to have worked sixteen hours, and
 * the person who could have stopped it has gone home.
 */
export async function endShift(): Promise<
  { ok: true; summary: ShiftSummary; closed: number } | { ok: false; error: string }
> {
  try {
    const user = await requireUser();

    const closed = await db.transaction(async (tx) => {
      const open = await tx
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.userId, user.id), isNull(timeEntries.endedAt)))
        .for("update");

      const now = new Date();
      for (const entry of open) {
        await tx
          .update(timeEntries)
          .set({
            endedAt: now,
            durationSeconds: Math.max(
              0,
              Math.round((now.getTime() - entry.startedAt.getTime()) / 1000)
            ),
          })
          .where(eq(timeEntries.id, entry.id));
      }
      return open.length;
    });

    const summary = await shiftSummaryFor(user.id);
    revalidatePath("/", "layout");
    return { ok: true, summary, closed };
  } catch {
    return { ok: false, error: "Could not end the shift. Please try again." };
  }
}
