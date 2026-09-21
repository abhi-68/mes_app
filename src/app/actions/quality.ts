"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { operationDependencies } from "@/db/schema";
import { requireRole } from "@/lib/session";
import { CommandError } from "@/lib/inventory";
import { allocateOutput, inspectOutput, satisfiedQuantityFor } from "@/lib/outputs";

const request = z
  .object({
    operationId: z.number().int().positive(),
    commandId: z.uuid(),
    quantity: z.number().int().positive(),
    verdict: z.enum(["PASS", "REWORK", "SCRAP"]),
    from: z.enum(["pendingInspection", "awaitingRework"]),
    requirementId: z.number().int().positive().nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

export type InspectionInput = z.infer<typeof request>;

const TO = { PASS: "accepted", REWORK: "awaitingRework", SCRAP: "scrapped" } as const;

/**
 * Record an inspector's verdict.
 *
 * A pass also hands the quantity to whatever operation is waiting on it, because
 * the two are one decision from the inspector's side: passing a part that final
 * assembly is held up on and then leaving it unallocated would keep the parent
 * blocked for no reason anyone on the floor could see.
 *
 * Both steps run under the caller's command id, so a retry after a lost response
 * replays rather than inspecting the same units twice.
 */
export async function recordInspection(
  input: InspectionInput
): Promise<{ ok: true; allocated: number } | { ok: false; error: string }> {
  try {
    const user = await requireRole("ADMIN", "SUPERVISOR");
    const parsed = request.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid inspection" };
    const { operationId, commandId, quantity, verdict, from, requirementId, reason } = parsed.data;

    if (from === "awaitingRework" && verdict === "REWORK") {
      return { ok: false, error: "That work is already waiting for rework" };
    }

    let allocated = 0;
    await db.transaction(async (tx) => {
      await inspectOutput(
        {
          commandId,
          operationId,
          from,
          to: TO[verdict],
          quantity,
          reason: reason || undefined,
          actorUserId: user.id,
        },
        { tx }
      );

      if (verdict !== "PASS" || !requirementId) return;
      // Never hand over more than is still owed — another route may have covered
      // part of it while this sat in the queue.
      const outstanding = await satisfiedQuantityFor(requirementId, { tx });
      const [dep] = await tx
        .select({ requiredQuantity: operationDependencies.requiredQuantity })
        .from(operationDependencies)
        .where(
          and(
            eq(operationDependencies.requirementId, requirementId),
            eq(operationDependencies.type, "REQUIRED_QUANTITY")
          )
        )
        .limit(1);
      const need = Math.max(0, (dep?.requiredQuantity ?? quantity) - outstanding);
      allocated = Math.min(quantity, need);
      if (allocated > 0) {
        await allocateOutput(
          { commandId: `${commandId}:allocate`, operationId, requirementId, quantity: allocated, actorUserId: user.id },
          { tx }
        );
      }
    });

    revalidatePath("/", "layout");
    return { ok: true, allocated };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not record that inspection. Check your access and retry." };
  }
}
