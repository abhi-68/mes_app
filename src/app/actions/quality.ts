"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  operationDependencies,
  qualityEvents,
  taskEvents,
  workOrderTasks,
  workOrders,
} from "@/db/schema";
import { requireRole, requireUser } from "@/lib/session";
import { canWorkOnTask, terminalStation } from "@/lib/terminal";
import { CommandError } from "@/lib/inventory";
import {
  allocateOutput,
  inspectOutput,
  satisfiedQuantityFor,
  scrapFinishedOutput,
} from "@/lib/outputs";

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

const scrapFinished = z
  .object({
    commandId: z.uuid(),
    operationId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    reasonCodeId: z.number().int().positive(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

/**
 * Write off work this step already finished.
 *
 * Open to whoever could have done the step, not just a supervisor. The person who
 * made the part is the one who notices it is wrong, and a write-off that needs
 * somebody else found first is a write-off that happens tomorrow, after the part
 * has moved.
 *
 * The step goes back to unfinished. It is: the order still wants the quantity, and
 * a step that owes work has no business sitting on a Done list.
 */
export async function scrapFinishedWork(
  input: z.infer<typeof scrapFinished>
): Promise<{ ok: true; result: { scrapped: number; reopened: boolean } } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const parsed = scrapFinished.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Say how many and why" };
    const { commandId, operationId, quantity, reasonCodeId, note } = parsed.data;

    const [task] = await db
      .select({
        id: workOrderTasks.id,
        status: workOrderTasks.status,
        stationId: workOrderTasks.stationId,
        assignedToUserId: workOrderTasks.assignedToUserId,
        workOrderId: workOrderTasks.workOrderId,
        itemId: workOrders.itemId,
      })
      .from(workOrderTasks)
      .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
      .where(eq(workOrderTasks.id, operationId));
    if (!task) return { ok: false, error: "That step does not exist" };

    const terminal = await terminalStation();
    const permission = canWorkOnTask({
      role: user.role,
      userId: user.id,
      homeStationId: user.stationId,
      terminalStationId: terminal?.id ?? null,
      taskStationId: task.stationId,
      assignedToUserId: task.assignedToUserId,
    });
    if (!permission.allowed) return { ok: false, error: permission.reason };

    let scrapped = 0;
    await db.transaction(async (tx) => {
      ({ scrapped } = await scrapFinishedOutput(
        {
          commandId,
          operationId,
          quantity,
          reason: note?.trim() || "Made wrong",
          actorUserId: user.id,
        },
        { tx }
      ));

      await tx.insert(qualityEvents).values({
        workOrderTaskId: operationId,
        type: "SCRAP",
        quantity,
        itemId: task.itemId,
        reasonCodeId,
        notes: note?.trim() || null,
        recordedByUserId: user.id,
      });

      if (task.status === "DONE") {
        await tx
          .update(workOrderTasks)
          .set({ status: "IN_PROGRESS", completedAt: null, completedByUserId: null })
          .where(eq(workOrderTasks.id, operationId));
        await tx
          .update(workOrders)
          .set({ status: "IN_PROGRESS" })
          .where(eq(workOrders.id, task.workOrderId));
      }

      await tx.insert(taskEvents).values({
        workOrderTaskId: operationId,
        type: "QUALITY",
        actorUserId: user.id,
        source: "HUMAN",
        payload: { type: "SCRAP", quantity, reasonCodeId },
      });
    });

    revalidatePath("/", "layout");
    return { ok: true, result: { scrapped, reopened: task.status === "DONE" } };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not record that. Retry — it will not record twice." };
  }
}
