# Source: src/app/actions/tasks.ts

The cut-over task action. Reproduced here in full because the source archive has not
been reaching the reviewer. Commit 6196158.

```ts
"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  workOrderTasks,
  workOrders,
  timeEntries,
  timeEntryAdjustments,
  qualityEvents,
  taskEvents,
  materialRequirements,
  inventoryLocations,
} from "@/db/schema";
import { requireUser, requireRole, isManager } from "@/lib/session";
import {
  reserveForRequirement,
  issueAgainstReservation,
  coverageFor,
  CommandError,
  type Exec,
} from "@/lib/inventory";

export type ActionResult = { ok: true } | { ok: false; error: string; code?: string };

/**
 * AUTHORIZATION BOUNDARY.
 *
 * Every mutating action passes through here before it touches anything. The engine
 * enforces accounting correctness; it says nothing about whether this caller may act.
 * A worker may act only at a station they are assigned to; supervisors and admins may
 * act anywhere, because they are the ones covering absences and clearing blocks.
 */
async function authorizeTask(taskId: number) {
  const user = await requireUser();
  const task = await db.query.workOrderTasks.findFirst({
    where: eq(workOrderTasks.id, taskId),
    with: { workOrder: true },
  });
  if (!task) throw new CommandError("Task not found", "NOT_FOUND");

  if (!isManager(user.role) && task.stationId && task.stationId !== user.stationId) {
    throw new CommandError("This step belongs to another station", "STATE_GUARD");
  }
  return { user, task };
}

function wrap(fn: () => Promise<void>): Promise<ActionResult> {
  return fn()
    .then(() => {
      revalidatePath("/", "layout");
      return { ok: true } as const;
    })
    .catch((err: unknown) => {
      if (err instanceof CommandError) {
        return { ok: false as const, error: err.message, code: err.code };
      }
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Something went wrong",
      };
    });
}

/** Default stock location until multi-location picking exists. */
async function defaultLocationId(exec: Exec): Promise<number> {
  const database = exec.tx ?? db;
  const [loc] = await database.select().from(inventoryLocations).limit(1);
  if (!loc) throw new CommandError("No stock location configured", "NOT_FOUND");
  return loc.id;
}

/**
 * Start a step.
 *
 * Status change, material issue, labour session and audit event all commit in ONE
 * transaction. A failure anywhere — most importantly an insufficient or held-stock
 * rejection from the engine — rolls the whole thing back, so the step cannot end up
 * started while its materials were never issued.
 *
 * `commandId` comes from the client and MUST be stable across retries of the same
 * user action. A fresh id per retry would defeat replay protection entirely.
 */
export async function startTask(taskId: number, commandId: string): Promise<ActionResult> {
  return wrap(async () => {
    const { user, task } = await authorizeTask(taskId);
    if (task.status === "DONE") throw new CommandError("Already complete", "STATE_GUARD");

    await db.transaction(async (tx) => {
      const exec: Exec = { tx };
      const locationId = await defaultLocationId(exec);
      const now = new Date();

      // Materials first: if they cannot be issued, nothing else happens.
      const reqs = await tx
        .select()
        .from(materialRequirements)
        .where(eq(materialRequirements.operationId, taskId));

      for (const req of reqs) {
        const cover = await coverageFor(req.id, exec);
        const outstanding = Math.max(0, req.requiredQty - cover.netIssued);
        if (outstanding === 0) continue;

        // Reserve whatever is still uncovered, then draw the whole outstanding amount.
        if (cover.activeReserved < outstanding) {
          await reserveForRequirement(
            {
              commandId: `${commandId}:reserve:${req.id}`,
              requirementId: req.id,
              itemId: req.itemId,
              locationId,
              quantity: outstanding - cover.activeReserved,
            },
            exec
          );
        }

        const after = await coverageFor(req.id, exec);
        if (after.uncovered > 0) {
          throw new CommandError(
            `Short ${after.uncovered} of the material this step needs`,
            "INSUFFICIENT_STOCK"
          );
        }

        await issueAgainstReservation(
          {
            commandId: `${commandId}:issue:${req.id}`,
            requirementId: req.id,
            itemId: req.itemId,
            locationId,
            quantity: outstanding,
            actorUserId: user.id,
          },
          exec
        );
      }

      await tx
        .update(workOrderTasks)
        .set({
          status: "IN_PROGRESS",
          startedAt: task.startedAt ?? now,
          blockedReasonCodeId: null,
          blockedNote: null,
        })
        .where(eq(workOrderTasks.id, taskId));

      const open = await tx
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workOrderTaskId, taskId),
            eq(timeEntries.userId, user.id),
            isNull(timeEntries.endedAt)
          )
        );
      if (open.length === 0) {
        await tx
          .insert(timeEntries)
          .values({ workOrderTaskId: taskId, userId: user.id, startedAt: now });
      }

      await tx
        .update(workOrders)
        .set({ status: "IN_PROGRESS" })
        .where(
          and(
            eq(workOrders.id, task.workOrderId),
            inArray(workOrders.status, ["PLANNED", "RELEASED"])
          )
        );

      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "STARTED",
        actorUserId: user.id,
        source: "HUMAN",
        payload: { commandId },
      });
    });
  });
}

/** Clock off without completing. */
export async function pauseTask(taskId: number): Promise<ActionResult> {
  return wrap(async () => {
    const { user } = await authorizeTask(taskId);
    await db.transaction(async (tx) => {
      await closeOpenEntries(tx, taskId, user.id);
      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "NOTE",
        actorUserId: user.id,
        source: "HUMAN",
        payload: { action: "clocked off" },
      });
    });
  });
}

export async function completeTask(taskId: number, note?: string): Promise<ActionResult> {
  return wrap(async () => {
    const { user, task } = await authorizeTask(taskId);
    if (task.status === "DONE") return;

    await db.transaction(async (tx) => {
      const now = new Date();
      await closeOpenEntries(tx, taskId, user.id);

      await tx
        .update(workOrderTasks)
        .set({
          status: "DONE",
          completedByUserId: user.id,
          completedAt: now,
          startedAt: task.startedAt ?? now,
          blockedReasonCodeId: null,
          blockedNote: null,
          notes: note?.trim() ? note.trim() : task.notes,
        })
        .where(eq(workOrderTasks.id, taskId));

      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "COMPLETED",
        actorUserId: user.id,
        source: "HUMAN",
        payload: note ? { note } : null,
      });

      const siblings = await tx
        .select({ status: workOrderTasks.status })
        .from(workOrderTasks)
        .where(eq(workOrderTasks.workOrderId, task.workOrderId));
      if (siblings.length > 0 && siblings.every((s) => s.status === "DONE")) {
        await tx
          .update(workOrders)
          .set({ status: "DONE" })
          .where(eq(workOrders.id, task.workOrderId));
      }
    });
  });
}

export async function reopenTask(taskId: number): Promise<ActionResult> {
  return wrap(async () => {
    const user = await requireRole("SUPERVISOR", "ADMIN");
    await db.transaction(async (tx) => {
      await tx
        .update(workOrderTasks)
        .set({ status: "IN_PROGRESS", completedAt: null, completedByUserId: null })
        .where(eq(workOrderTasks.id, taskId));
      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "REOPENED",
        actorUserId: user.id,
        source: "HUMAN",
      });
    });
  });
}

export async function blockTask(
  taskId: number,
  reasonCodeId: number | null,
  note: string
): Promise<ActionResult> {
  return wrap(async () => {
    const { user, task } = await authorizeTask(taskId);
    if (!note.trim()) throw new CommandError("Say what is blocking this step", "STATE_GUARD");

    await db.transaction(async (tx) => {
      await closeOpenEntries(tx, taskId, user.id);
      await tx
        .update(workOrderTasks)
        .set({ status: "BLOCKED", blockedReasonCodeId: reasonCodeId, blockedNote: note.trim() })
        .where(eq(workOrderTasks.id, taskId));
      await tx
        .update(workOrders)
        .set({ status: "ON_HOLD" })
        .where(eq(workOrders.id, task.workOrderId));
      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "BLOCKED",
        actorUserId: user.id,
        source: "HUMAN",
        payload: { reasonCodeId, note },
      });
    });
  });
}

export async function unblockTask(taskId: number): Promise<ActionResult> {
  return wrap(async () => {
    const { user, task } = await authorizeTask(taskId);
    await db.transaction(async (tx) => {
      await tx
        .update(workOrderTasks)
        .set({ status: "PENDING", blockedReasonCodeId: null, blockedNote: null })
        .where(eq(workOrderTasks.id, taskId));

      const stillBlocked = await tx
        .select({ id: workOrderTasks.id })
        .from(workOrderTasks)
        .where(
          and(
            eq(workOrderTasks.workOrderId, task.workOrderId),
            eq(workOrderTasks.status, "BLOCKED")
          )
        );
      if (stillBlocked.length === 0) {
        await tx
          .update(workOrders)
          .set({ status: "IN_PROGRESS" })
          .where(eq(workOrders.id, task.workOrderId));
      }
      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "UNBLOCKED",
        actorUserId: user.id,
        source: "HUMAN",
      });
    });
  });
}

export async function recordQuality(
  taskId: number,
  type: "SCRAP" | "REWORK",
  quantity: number,
  reasonCodeId: number | null,
  notes: string
): Promise<ActionResult> {
  return wrap(async () => {
    const { user } = await authorizeTask(taskId);
    if (quantity < 1) throw new CommandError("Quantity must be at least 1", "STATE_GUARD");

    await db.transaction(async (tx) => {
      await tx.insert(qualityEvents).values({
        workOrderTaskId: taskId,
        type,
        quantity,
        reasonCodeId,
        notes: notes.trim() || null,
        recordedByUserId: user.id,
      });
      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "QUALITY",
        actorUserId: user.id,
        source: "HUMAN",
        payload: { type, quantity, reasonCodeId },
      });
    });
  });
}

/**
 * Correct a recorded time. The original row is never touched — this writes an
 * adjustment naming who changed it, from what, to what, and why.
 */
export async function adjustTimeEntry(
  timeEntryId: number,
  newMinutes: number,
  reason: string
): Promise<ActionResult> {
  return wrap(async () => {
    const user = await requireRole("SUPERVISOR", "ADMIN");
    if (!reason.trim()) throw new CommandError("A correction needs a reason", "STATE_GUARD");
    if (newMinutes < 0) throw new CommandError("Time cannot be negative", "STATE_GUARD");

    const entry = await db.query.timeEntries.findFirst({
      where: eq(timeEntries.id, timeEntryId),
      with: { adjustments: true },
    });
    if (!entry) throw new CommandError("Time entry not found", "NOT_FOUND");

    const current =
      entry.adjustments.length > 0
        ? entry.adjustments[entry.adjustments.length - 1].newDurationSeconds
        : entry.durationSeconds;

    await db.insert(timeEntryAdjustments).values({
      timeEntryId,
      adjustedByUserId: user.id,
      previousDurationSeconds: current,
      newDurationSeconds: Math.round(newMinutes * 60),
      reason: reason.trim(),
    });
  });
}

// --------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function closeOpenEntries(tx: Tx, taskId: number, userId: number) {
  const open = await tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workOrderTaskId, taskId),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.endedAt)
      )
    );

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
}
```
