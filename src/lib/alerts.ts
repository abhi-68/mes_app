/**
 * Alerts.
 *
 * The distinction this file is built around: a **transition** is a fact about a
 * moment that nobody can recompute later (a step was blocked; the part a station
 * was waiting on arrived), so it is stored and can be acknowledged. A
 * **condition** is simply true right now (material is short; a step has run past
 * its estimate), so it is derived on read and disappears by itself when the
 * problem goes away. Storing conditions is how alert lists fill up with things
 * that were fixed hours ago.
 *
 * Nothing here pushes. There is no email, no SMS and no background job — the feed
 * and the badge are read when someone opens the app. That is a deliberate first
 * step, not an oversight: who gets told what, how loudly, and how long before it
 * escalates are a supervisor's judgements about their own floor.
 */
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  alerts,
  workOrderTasks,
  workOrders,
  stations,
  items,
  timeEntries,
  inventoryBalances,
  operationDependencies,
} from "@/db/schema";
import type { Exec } from "@/lib/inventory";
import { blockersForOperations } from "@/lib/dependencies";
import { scheduleOpenWork, plantLateCauses } from "@/lib/schedule-data";
import type { SessionUser } from "@/lib/session";

/** A step is "late" once it has run this many times its expected minutes. */
export const LATE_MULTIPLIER = 2;

export type AlertKind =
  | "STEP_BLOCKED"
  | "STEP_READY"
  | "ASSIGNED_TO_YOU"
  | "MATERIAL_SHORT"
  | "RUNNING_LATE"
  | "ORDER_AT_RISK"
  | "BELOW_REORDER";

export type Alert = {
  /** Stored alerts have a numeric id; derived ones are keyed by what they describe. */
  key: string;
  id: number | null;
  kind: AlertKind;
  severity: "attention" | "good" | "info";
  title: string;
  detail: string | null;
  taskId: number | null;
  workOrderId: number | null;
  orderNumber: string | null;
  stationName: string | null;
  at: Date;
  /** Derived alerts cannot be dismissed — they clear when the condition does. */
  acknowledgeable: boolean;
};

// ---------------------------------------------------------------------------
// Writing transitions
// ---------------------------------------------------------------------------

/**
 * Insert unless the same thing is already open.
 *
 * Without this, blocking and unblocking a step three times leaves three identical
 * unread alerts, and the feed stops being worth reading.
 */
export async function raiseAlert(
  input: {
    kind: "STEP_BLOCKED" | "STEP_READY" | "ASSIGNED_TO_YOU";
    workOrderTaskId?: number | null;
    workOrderId?: number | null;
    audienceStationId?: number | null;
    audienceUserId?: number | null;
    title: string;
    detail?: string | null;
    createdByUserId?: number | null;
  },
  exec: Exec = {}
): Promise<void> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  if (input.workOrderTaskId) {
    // Same kind, same step, same audience. The audience is part of the identity
    // because reassigning a step from one person to another must reach the new
    // person — an open alert addressed to the previous one is not the same news.
    const open = await database
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.kind, input.kind),
          eq(alerts.workOrderTaskId, input.workOrderTaskId),
          isNull(alerts.acknowledgedAt),
          input.audienceUserId
            ? eq(alerts.audienceUserId, input.audienceUserId)
            : isNull(alerts.audienceUserId)
        )
      );
    if (open.length > 0) return;
  }

  await database.insert(alerts).values({
    kind: input.kind,
    workOrderTaskId: input.workOrderTaskId ?? null,
    workOrderId: input.workOrderId ?? null,
    audienceStationId: input.audienceStationId ?? null,
    audienceUserId: input.audienceUserId ?? null,
    title: input.title,
    detail: input.detail ?? null,
    createdByUserId: input.createdByUserId ?? null,
  });
}

/**
 * Close any open "this is yours" alert on a step.
 *
 * Called before reassigning and when the step is taken back, so the previous
 * assignee's feed does not keep telling them to do something that is no longer
 * theirs. Passing `exceptUserId` keeps the incoming assignee's own alert alive
 * when a supervisor re-confirms the same person.
 */
export async function closeAssignmentAlerts(
  taskId: number,
  actorUserId: number,
  exec: Exec = {},
  exceptUserId?: number | null
): Promise<void> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const conditions = [
    eq(alerts.kind, "ASSIGNED_TO_YOU" as const),
    eq(alerts.workOrderTaskId, taskId),
    isNull(alerts.acknowledgedAt),
  ];
  if (exceptUserId) conditions.push(sql`${alerts.audienceUserId} is distinct from ${exceptUserId}`);

  await database
    .update(alerts)
    .set({ acknowledgedAt: new Date(), acknowledgedByUserId: actorUserId })
    .where(and(...conditions));
}

/**
 * Tell the stations that were waiting on this operation that it has delivered.
 *
 * This is the alert that matters most here. Everyone thinks of alerts as telling
 * a manager something broke; the hours Thermal Corp actually loses are between
 * the moment a blocker clears and the moment the person waiting finds out.
 *
 * Call it after the causing change is written, inside the same transaction, so
 * readiness is evaluated against the new state.
 */
export async function announceNewlyReady(
  sourceOperationId: number,
  exec: Exec = {}
): Promise<void> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  const dependents = await database
    .selectDistinct({ operationId: operationDependencies.operationId })
    .from(operationDependencies)
    .where(eq(operationDependencies.dependsOnOperationId, sourceOperationId));
  if (dependents.length === 0) return;

  const ids = dependents.map((d) => d.operationId);
  const blockers = await blockersForOperations(ids, exec);

  const rows = await database
    .select({
      id: workOrderTasks.id,
      name: workOrderTasks.name,
      status: workOrderTasks.status,
      stationId: workOrderTasks.stationId,
      workOrderId: workOrderTasks.workOrderId,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
    })
    .from(workOrderTasks)
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .where(inArray(workOrderTasks.id, ids));

  for (const row of rows) {
    if (row.status !== "PENDING") continue;
    if ((blockers.get(row.id) ?? []).length > 0) continue;

    await raiseAlert(
      {
        kind: "STEP_READY",
        workOrderTaskId: row.id,
        workOrderId: row.workOrderId,
        audienceStationId: row.stationId,
        title: `Ready to start: ${row.name}`,
        detail: `Everything this step was waiting on has arrived — ${row.itemName} (${row.orderNumber}).`,
      },
      exec
    );
  }
}

/**
 * Clear the alerts that were asking someone to start this step, now that it has
 * been started. Both the station-wide "ready" notice and any personal "this is
 * yours" notice: the news has been acted on and neither is worth reading again.
 */
export async function acknowledgeReadyAlerts(
  taskId: number,
  userId: number,
  exec: Exec = {}
): Promise<void> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  await database
    .update(alerts)
    .set({ acknowledgedAt: new Date(), acknowledgedByUserId: userId })
    .where(
      and(
        inArray(alerts.kind, ["STEP_READY", "ASSIGNED_TO_YOU"]),
        eq(alerts.workOrderTaskId, taskId),
        isNull(alerts.acknowledgedAt)
      )
    );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const isManagerRole = (role: string) => role === "SUPERVISOR" || role === "ADMIN";

/**
 * Everything this person should be looking at, newest first.
 * Stored transitions and derived conditions merged into one list.
 */
export async function alertsFor(user: SessionUser, exec: Exec = {}): Promise<Alert[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const manager = isManagerRole(user.role);

  // --- stored transitions --------------------------------------------------
  //
  // Three audiences, narrowest first. An alert naming one person reaches that
  // person and nobody else — including supervisors, who would otherwise get a
  // copy of every "this is yours" they hand out and stop reading the feed.
  const addressedToMe = eq(alerts.audienceUserId, user.id);
  const audience = manager
    ? // Everything not addressed to a specific person, plus whatever names them.
      or(isNull(alerts.audienceUserId), addressedToMe)
    : user.stationId
      ? // A worker sees their station's news and their own name. Nothing addressed
        // to supervisors; their own station's blocked steps are on their queue.
        or(
          addressedToMe,
          and(eq(alerts.audienceStationId, user.stationId), isNull(alerts.audienceUserId))
        )
      : addressedToMe;

  const stored = await database
    .select({
      id: alerts.id,
      kind: alerts.kind,
      title: alerts.title,
      detail: alerts.detail,
      createdAt: alerts.createdAt,
      taskId: alerts.workOrderTaskId,
      workOrderId: alerts.workOrderId,
      orderNumber: workOrders.orderNumber,
      // The station of the STEP, not of the audience — a supervisor reading a
      // blocked alert wants to know where on the floor it is, and the audience
      // for that alert is nobody in particular.
      stationName: stations.name,
    })
    .from(alerts)
    .leftJoin(workOrders, eq(alerts.workOrderId, workOrders.id))
    .leftJoin(workOrderTasks, eq(alerts.workOrderTaskId, workOrderTasks.id))
    .leftJoin(stations, eq(workOrderTasks.stationId, stations.id))
    .where(and(isNull(alerts.acknowledgedAt), audience))
    .orderBy(desc(alerts.createdAt))
    .limit(60);

  const out: Alert[] = stored.map((a) => ({
    key: `stored:${a.id}`,
    id: a.id,
    kind: a.kind as AlertKind,
    severity:
      a.kind === "STEP_READY" ? "good" : a.kind === "ASSIGNED_TO_YOU" ? "info" : "attention",
    title: a.title,
    detail: a.detail,
    taskId: a.taskId,
    workOrderId: a.workOrderId,
    orderNumber: a.orderNumber,
    stationName: a.stationName,
    at: a.createdAt,
    acknowledgeable: true,
  }));

  // --- derived conditions --------------------------------------------------
  out.push(...(await materialShortAlerts(user, exec)));
  out.push(...(await runningLateAlerts(user, exec)));
  out.push(...(await scheduleRiskAlerts(user, exec)));
  out.push(...(await belowReorderAlerts(user, exec)));

  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export async function alertCountFor(user: SessionUser, exec: Exec = {}): Promise<number> {
  return (await alertsFor(user, exec)).length;
}

/**
 * Stock that has fallen to its reorder point.
 *
 * Distinct from a shortage: a shortage means a step cannot start today, this means
 * buy more before one does. Measured on free stock — on hand less what is already
 * reserved and held — because stock promised to another order will not save you.
 */
async function belowReorderAlerts(user: SessionUser, exec: Exec = {}): Promise<Alert[]> {
  if (!isManagerRole(user.role)) return [];
  const database = exec.tx ?? exec.db ?? defaultDb;

  const rows = await database
    .select({
      itemId: items.id,
      sku: items.sku,
      name: items.name,
      uom: items.unitOfMeasure,
      reorderPoint: items.reorderPoint,
      onHand: inventoryBalances.onHand,
      reserved: inventoryBalances.activeReserved,
      held: inventoryBalances.heldQty,
    })
    .from(items)
    .leftJoin(inventoryBalances, eq(inventoryBalances.itemId, items.id))
    .where(and(eq(items.active, true), gt(items.reorderPoint, 0)));

  const free = new Map<number, { free: number; row: (typeof rows)[number] }>();
  for (const r of rows) {
    const available = (r.onHand ?? 0) - (r.reserved ?? 0) - (r.held ?? 0);
    const seen = free.get(r.itemId);
    // An item can hold stock in several locations; the threshold is across all of them.
    if (seen) seen.free += available;
    else free.set(r.itemId, { free: available, row: r });
  }

  const result: Alert[] = [];
  for (const { free: available, row } of free.values()) {
    if (available > row.reorderPoint) continue;
    result.push({
      key: `reorder:${row.itemId}`,
      id: null,
      kind: "BELOW_REORDER",
      severity: "attention",
      title: `Order more ${row.name}`,
      detail: `${available} ${row.uom} free against a reorder point of ${row.reorderPoint}.`,
      taskId: null,
      workOrderId: null,
      orderNumber: null,
      stationName: null,
      at: new Date(),
      acknowledgeable: false,
    });
  }
  return result;
}

/** Steps that cannot be covered from stock. Managers only — a worker cannot buy. */
async function materialShortAlerts(user: SessionUser, exec: Exec = {}): Promise<Alert[]> {
  if (!isManagerRole(user.role)) return [];
  const database = exec.tx ?? exec.db ?? defaultDb;

  const open = await database
    .select({
      id: workOrderTasks.id,
      name: workOrderTasks.name,
      workOrderId: workOrderTasks.workOrderId,
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      stationName: stations.name,
      createdAt: workOrders.createdAt,
    })
    .from(workOrderTasks)
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .leftJoin(stations, eq(workOrderTasks.stationId, stations.id))
    .where(
      and(
        inArray(workOrderTasks.status, ["PENDING", "BLOCKED"]),
        inArray(workOrders.status, ["RELEASED", "IN_PROGRESS"])
      )
    );
  if (open.length === 0) return [];

  const blockers = await blockersForOperations(
    open.map((o) => o.id),
    exec
  );

  const result: Alert[] = [];
  for (const row of open) {
    for (const b of blockers.get(row.id) ?? []) {
      if (b.kind !== "MATERIAL") continue;
      result.push({
        key: `short:${row.id}:${b.itemSku}`,
        id: null,
        kind: "MATERIAL_SHORT",
        severity: "attention",
        title: b.detail,
        detail: `${row.name} on ${row.orderNumber} cannot start until this arrives.`,
        taskId: row.id,
        workOrderId: row.workOrderId,
        orderNumber: row.orderNumber,
        stationName: row.stationName,
        at: row.createdAt,
        acknowledgeable: false,
      });
    }
  }
  return result;
}

/**
 * Steps whose clock has run past LATE_MULTIPLIER times the estimate.
 *
 * Derived from the open labour session rather than from a stored flag, so a step
 * stops being late the moment it is finished or paused — which is what a
 * supervisor means by the word.
 */
async function runningLateAlerts(user: SessionUser, exec: Exec = {}): Promise<Alert[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const manager = isManagerRole(user.role);

  const running = await database
    .select({
      taskId: workOrderTasks.id,
      name: workOrderTasks.name,
      expectedMinutes: workOrderTasks.expectedMinutes,
      startedAt: timeEntries.startedAt,
      workOrderId: workOrderTasks.workOrderId,
      orderNumber: workOrders.orderNumber,
      stationId: workOrderTasks.stationId,
      stationName: stations.name,
    })
    .from(timeEntries)
    .innerJoin(workOrderTasks, eq(timeEntries.workOrderTaskId, workOrderTasks.id))
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .leftJoin(stations, eq(workOrderTasks.stationId, stations.id))
    .where(
      manager
        ? isNull(timeEntries.endedAt)
        : and(
            isNull(timeEntries.endedAt),
            user.stationId
              ? or(
                  eq(workOrderTasks.stationId, user.stationId),
                  eq(timeEntries.userId, user.id)
                )
              : eq(timeEntries.userId, user.id)
          )
    );

  const now = Date.now();
  const result: Alert[] = [];
  for (const r of running) {
    if (!r.expectedMinutes || r.expectedMinutes <= 0) continue;
    const elapsedMinutes = (now - r.startedAt.getTime()) / 60_000;
    if (elapsedMinutes < r.expectedMinutes * LATE_MULTIPLIER) continue;

    const hours = Math.floor(elapsedMinutes / 60);
    const mins = Math.round(elapsedMinutes % 60);
    result.push({
      key: `late:${r.taskId}`,
      id: null,
      kind: "RUNNING_LATE",
      severity: "attention",
      title: `Running long: ${r.name}`,
      detail: `${hours > 0 ? `${hours}h ` : ""}${mins}m on the clock against ${r.expectedMinutes}m estimated, on ${r.orderNumber}.`,
      taskId: r.taskId,
      workOrderId: r.workOrderId,
      orderNumber: r.orderNumber,
      stationName: r.stationName,
      at: r.startedAt,
      acknowledgeable: false,
    });
  }
  return result;
}

/**
 * The step that is about to make an order late — or has just started to.
 *
 * Not "this step is waiting", which is ordinary and constant. This is the head of
 * a chain that has run out of room: nothing upstream of it is in trouble, so it is
 * the thing to go and look at. `blocking` is how much sits behind it, which is the
 * difference between a nuisance and a problem.
 *
 * AT_RISK exists because the breach alert on its own arrives too late to act on.
 * Fast-forwarding the seeded floor, an order sat on 350 minutes of slack in silence
 * and was 1076 minutes late three days later. The warning is the useful half.
 */
async function scheduleRiskAlerts(user: SessionUser, exec: Exec = {}): Promise<Alert[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const manager = isManagerRole(user.role);
  if (!manager && !user.stationId) return [];

  const now = new Date();
  const plant = await scheduleOpenWork(now, exec);
  const causes = plantLateCauses(plant, now);
  if (causes.length === 0) return [];

  const rows = await database
    .select({
      taskId: workOrderTasks.id,
      name: workOrderTasks.name,
      jobNumber: workOrderTasks.jobNumber,
      stationId: workOrderTasks.stationId,
      stationName: stations.name,
      workOrderId: workOrderTasks.workOrderId,
      orderNumber: workOrders.orderNumber,
    })
    .from(workOrderTasks)
    .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
    .leftJoin(stations, eq(workOrderTasks.stationId, stations.id))
    .where(
      inArray(
        workOrderTasks.id,
        causes.map((c) => c.taskId)
      )
    );
  const detail = new Map(rows.map((r) => [r.taskId, r]));

  const result: Alert[] = [];
  for (const c of causes) {
    const d = detail.get(c.taskId);
    if (!d) continue;
    // A worker is told about their own bench, not about the whole plant.
    if (!manager && d.stationId !== user.stationId) continue;

    const span = formatSpan(Math.abs(c.lateByMinutes));
    const behind =
      c.blocking > 0 ? ` Holding ${c.blocking} step${c.blocking === 1 ? "" : "s"}.` : "";

    result.push({
      key: `risk:${c.taskId}:${c.severity}`,
      id: null,
      kind: "ORDER_AT_RISK",
      severity: "attention",
      title:
        c.severity === "LATE"
          ? `${d.orderNumber} is losing time: ${d.name}`
          : `${d.orderNumber} is close to late: ${d.name}`,
      detail:
        c.severity === "LATE"
          ? `Should have started ${span} ago.${behind}`
          : `Has to start within ${span}.${behind}`,
      taskId: c.taskId,
      workOrderId: c.workOrderId,
      orderNumber: d.orderNumber,
      stationName: d.stationName,
      at: now,
      acknowledgeable: false,
    });
  }
  return result;
}

/** Working minutes as something a person reads. A day is a shift, not 24 hours. */
function formatSpan(minutes: number): string {
  const days = Math.floor(minutes / 480);
  const hours = Math.floor((minutes % 480) / 60);
  const mins = Math.round(minutes % 60);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${mins > 0 ? ` ${mins}m` : ""}`;
  return `${mins}m`;
}
