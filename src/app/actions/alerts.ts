"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { alerts } from "@/db/schema";
import { requireUser } from "@/lib/session";
import type { ActionResult } from "@/app/actions/tasks";

/**
 * Mark one alert dealt with.
 *
 * Only stored transitions can be acknowledged. A derived alert — material short,
 * running late — has no row and no dismiss button: it clears when the condition
 * clears, which is the point of not storing it.
 */
export async function acknowledgeAlert(alertId: number): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await db
      .update(alerts)
      .set({ acknowledgedAt: new Date(), acknowledgedByUserId: user.id })
      .where(and(eq(alerts.id, alertId), isNull(alerts.acknowledgedAt)));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not clear that alert",
    };
  }
}
