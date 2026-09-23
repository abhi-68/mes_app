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
  reasonCodes,
  alerts,
} from "@/db/schema";
import { users } from "@/db/schema";
import { pickingLocation } from "@/lib/material-planning";
import { requireUser, requireRole } from "@/lib/session";
import { canWorkOnTask, terminalStation } from "@/lib/terminal";
import {
  reserveForRequirement,
  receiveStock,
  coverageFor,
  availableNow,
  CommandError,
  type Exec,
} from "@/lib/inventory";
import { blockersFor } from "@/lib/dependencies";
import { outstandingPickCount } from "@/lib/picking";
import { deliverCompletedSubAssembly, satisfiedQuantityFor } from "@/lib/outputs";
import {
  raiseAlert,
  announceNewlyReady,
  acknowledgeReadyAlerts,
  closeAssignmentAlerts,
} from "@/lib/alerts";

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

  const terminal = await terminalStation();
  const permission = canWorkOnTask({
    role: user.role,
    userId: user.id,
    homeStationId: user.stationId,
    terminalStationId: terminal?.id ?? null,
    taskStationId: task.stationId,
    assignedToUserId: task.assignedToUserId,
  });
  if (!permission.allowed) throw new CommandError(permission.reason, "STATE_GUARD");

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
  const loc = await pickingLocation(exec);
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
    const { user } = await authorizeTask(taskId);

    await db.transaction(async (tx) => {
      // Share the task lock with material planning; stale previews and concurrent
      // starts must not reserve the same outstanding requirement twice.
      const [task] = await tx.select().from(workOrderTasks)
        .where(eq(workOrderTasks.id, taskId)).for("update");
      if (!task) throw new CommandError("Task not found", "NOT_FOUND");
      if (task.status === "DONE") throw new CommandError("Already complete", "STATE_GUARD");
      const exec: Exec = { tx };
      const locationId = await defaultLocationId(exec);
      const now = new Date();

      // Dependencies first — and on the SERVER, not merely greyed out in the UI.
      // Skipped for a step already running, so a retry of the same start is not
      // rejected by a predecessor that this very step is waiting on.
      if (task.status !== "IN_PROGRESS") {
        // Both SEQUENCE and DEPENDENCY block. MATERIAL deliberately does not — the
        // issue path below refuses it a few lines later with a better message, and
        // reserving is what makes a marginal case succeed rather than guessing here.
        const waiting = (await blockersFor(taskId, exec)).filter((b) => b.kind !== "MATERIAL");
        if (waiting.length > 0) {
          throw new CommandError(waiting[0].detail, "DEPENDENCY");
        }
      }

      // Materials next: if they cannot be issued, nothing else happens.
      const reqs = await tx
        .select()
        .from(materialRequirements)
        .where(eq(materialRequirements.operationId, taskId));

      for (const req of reqs) {
        const cover = await coverageFor(req.id, exec);
        // A component built in-house is satisfied by the sub-assembly's own output
        // being allocated or installed, NOT by stock in a location. Without this the
        // dependency layer reports the step ready and this loop then refuses it for
        // lack of stock that is never going to exist — the step becomes unstartable.
        const fromSubAssembly = await satisfiedQuantityFor(req.id, exec);
        const outstanding = Math.max(
          0,
          req.requiredQty - cover.netIssued - fromSubAssembly
        );
        if (outstanding === 0) continue;

        // Nothing is reserved or issued here. Start no longer commits stock: the
        // handler collects it and scans each batch they lift, and that is what
        // moves it. All that is left to decide is which of the two refusals the
        // worker gets — go and fetch it, or it is not in the building.
        const free = await availableNow(req.itemId, locationId, exec);
        if (free + cover.activeReserved < outstanding) {
          throw new CommandError(
            `Short ${outstanding - free - cover.activeReserved} of the material this step needs`,
            "INSUFFICIENT_STOCK"
          );
        }

        // The stock exists, but it is on the rack rather than in their hands.
        // Starting the clock now would put walking and fetching into the build
        // time, and the batch actually taken would be recorded after the fact.
        throw new CommandError(
          `Collect the material first — ${outstanding} still to scan`,
          "MATERIAL_NOT_COLLECTED"
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

      // The station has acted on the news, so the alert has done its job.
      await acknowledgeReadyAlerts(taskId, user.id, exec);

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

    // Start already refuses while material is on the rack, but this is the moment
    // the books say the part was built. A step finished with its material never
    // drawn leaves stock that was physically used still sitting on the balance.
    const stillToCollect = await outstandingPickCount(taskId);
    if (stillToCollect > 0) {
      throw new CommandError(
        `Collect the material first — ${stillToCollect} still to scan`,
        "MATERIAL_NOT_COLLECTED"
      );
    }

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

      // A step finished without ever being started leaves its "ready" and "this is
      // yours" alerts open otherwise, and they can never come true again.
      await acknowledgeReadyAlerts(taskId, user.id, { tx });

      const siblings = await tx
        .select({ status: workOrderTasks.status })
        .from(workOrderTasks)
        .where(eq(workOrderTasks.workOrderId, task.workOrderId));
      if (siblings.length > 0 && siblings.every((s) => s.status === "DONE")) {
        await tx
          .update(workOrders)
          .set({ status: "DONE" })
          .where(eq(workOrders.id, task.workOrderId));

        /*
         * A finished top-level unit becomes stock.
         *
         * Until now a completed order simply stopped existing as far as the racks
         * were concerned: it was DONE, and nothing on the floor could see the
         * thing itself. Receiving it as finished goods is what lets somebody walk
         * to a rack, find it, and load it — and it is where the forklift's list
         * comes from.
         *
         * Sub-assemblies are deliberately NOT received: they are consumed by their
         * parent through the output path, and putting them in stock as well would
         * count the same thing twice.
         */
        const [order] = await tx
          .select()
          .from(workOrders)
          .where(eq(workOrders.id, task.workOrderId));
        if (order && order.parentWorkOrderId === null) {
          const locationId = await defaultLocationId({ tx });
          await receiveStock(
            {
              commandId: `finish:${order.id}`,
              itemId: order.itemId,
              locationId,
              quantity: order.quantity,
              actorUserId: user.id,
              lot: {
                batchNumber: order.orderNumber,
                procurementReference: order.orderNumber,
                storageLocation: "Finished goods",
              },
            },
            { tx }
          );
        }
      }

      // If a parent order was waiting on this sub-assembly, hand it over and
      // tell the station that has been waiting. Both inside this transaction,
      // so a failure here does not leave the step marked done and the parent
      // still waiting on something that has in fact been built.
      await deliverCompletedSubAssembly(
        { operationId: taskId, actorUserId: user.id },
        { tx }
      );
      await announceNewlyReady(taskId, { tx });
    });
  });
}

/**
 * Hand a step to a named person, or take it back (`userId === null`).
 *
 * This is the thing a big ERP does badly. Epicor's work queue lives only inside
 * the shop-floor terminal and there is no way to give a specific job to a specific
 * person from the main application — an open enhancement request its customers
 * have been asking about for years. It is one column and one guard here.
 *
 * The guard matters: a worker may only act at their own station, so assigning
 * someone a step at another station would produce work they can see and cannot
 * start. Better to refuse the assignment than to create that dead end.
 */
export async function assignTask(
  taskId: number,
  userId: number | null
): Promise<ActionResult> {
  return wrap(async () => {
    const actor = await requireRole("SUPERVISOR", "ADMIN");

    const task = await db.query.workOrderTasks.findFirst({
      where: eq(workOrderTasks.id, taskId),
      with: { workOrder: { with: { item: true } }, station: true },
    });
    if (!task) throw new CommandError("Step not found", "NOT_FOUND");
    if (task.status === "DONE") {
      throw new CommandError("That step is already finished", "STATE_GUARD");
    }
    if (task.assignedToUserId === userId) return; // Nothing changed; no alert, no noise.

    let assignee: { id: number; name: string; role: string; stationId: number | null } | null =
      null;
    if (userId !== null) {
      const found = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!found) throw new CommandError("That person is not in the system", "NOT_FOUND");
      if (!found.active) throw new CommandError(`${found.name} is not active`, "STATE_GUARD");
      // Deliberately NOT refused when they work elsewhere. Giving someone a step
      // by name is how a supervisor moves one person to another station for one
      // job, and `canWorkOnTask` honours that, so the assignment is startable.
      // It used to be refused because the start guard would have blocked it —
      // that guard is the thing that changed.
      assignee = found;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(workOrderTasks)
        .set({
          assignedToUserId: userId,
          assignedByUserId: userId === null ? null : actor.id,
          assignedAt: userId === null ? null : new Date(),
        })
        .where(eq(workOrderTasks.id, taskId));

      await tx.insert(taskEvents).values({
        workOrderTaskId: taskId,
        type: "ASSIGNED",
        actorUserId: actor.id,
        source: "HUMAN",
        payload: {
          assignedToUserId: userId,
          assignedToName: assignee?.name ?? null,
          previousUserId: task.assignedToUserId,
        },
      });

      // Whoever had it before should stop seeing it in their feed.
      await closeAssignmentAlerts(taskId, actor.id, { tx }, userId);

      if (assignee) {
        await raiseAlert(
          {
            kind: "ASSIGNED_TO_YOU",
            workOrderTaskId: taskId,
            workOrderId: task.workOrderId,
            audienceUserId: assignee.id,
            title: `${actor.name} gave you: ${task.name}`,
            detail: `${task.workOrder.item.name} (${task.workOrder.orderNumber})${
              task.station ? ` at ${task.station.name}` : ""
            }.`,
            createdByUserId: actor.id,
          },
          { tx }
        );
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

      // Somebody has to be told. The worker has done what they can.
      const reason = reasonCodeId
        ? (
            await tx
              .select({ label: reasonCodes.label })
              .from(reasonCodes)
              .where(eq(reasonCodes.id, reasonCodeId))
          )[0]?.label
        : null;

      await raiseAlert(
        {
          kind: "STEP_BLOCKED",
          workOrderTaskId: taskId,
          workOrderId: task.workOrderId,
          audienceStationId: null, // supervisors and admins
          title: `Blocked: ${task.name}`,
          detail: [reason, note.trim()].filter(Boolean).join(" — "),
          createdByUserId: user.id,
        },
        { tx }
      );
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

      // The thing the alert was about is over, so it closes itself rather than
      // waiting for someone to tidy the list.
      await tx
        .update(alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedByUserId: user.id })
        .where(
          and(
            eq(alerts.kind, "STEP_BLOCKED"),
            eq(alerts.workOrderTaskId, taskId),
            isNull(alerts.acknowledgedAt)
          )
        );
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
