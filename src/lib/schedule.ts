/**
 * Finite-capacity scheduling and critical path.
 *
 * Answers two questions the floor actually asks:
 *   "can this order be finished by its due date?"  -> projectedFinish vs dueDate
 *   "what is making us late?"                      -> lateRootCauses()
 *
 * WHAT IS MODELLED
 *   - Station capacity: how many jobs can run at one station at once.
 *   - A working calendar: eight hours a day, Monday to Friday. Eight hours of
 *     work started at 14:00 finishes at 10:00 tomorrow, not at 22:00 tonight.
 *   - The existing dependency graph, unchanged — the routing chain and the
 *     convergent edges onto sub-assemblies are already explicit records.
 *
 * WHAT IS NOT, AND IS STATED ON SCREEN RATHER THAN HIDDEN HERE
 *   - Labour. One person per job, always someone available. A real plant runs
 *     out of welders long before it runs out of welding bays.
 *   - Machine capability. Two cells at a station are assumed interchangeable.
 *   - Setup and changeover time, travel between stations, and material lead time.
 *
 * THE ANSWER IS A GOOD ONE, NOT THE BEST ONE. Optimal job-shop scheduling is
 * NP-hard. This is list scheduling with an earliest-due-date priority rule, which
 * is what production schedulers actually use. Change the rule and the dates move;
 * that is a property of the problem, not a defect here.
 */

export type WorkingCalendar = {
  /** 0 = Sunday. Default is Monday–Friday. */
  workingDays: number[];
  /** Shift start, local time. */
  startHour: number;
  startMinute: number;
  /** Paid working minutes in a day, breaks already deducted. */
  minutesPerDay: number;
};

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  startHour: 7,
  startMinute: 0,
  minutesPerDay: 480,
};

/** Used when a step carries no estimate. Counted and surfaced, never silent. */
export const DEFAULT_TASK_MINUTES = 60;

/**
 * Warn this long before a step's latest start, not merely once it has passed.
 *
 * One shift. Fast-forwarding the real data showed the breach alert firing at the
 * exact moment the order became unrecoverable — six days out it had 350 minutes of
 * slack and said nothing, three days later it was 1076 minutes late. An alert that
 * only speaks after the fact is a report, not a warning.
 */
export const AT_RISK_THRESHOLD_MINUTES = 480;

/** Guard against a malformed calendar spinning forever. */
const MAX_DAYS = 2000;

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function shiftStart(cal: WorkingCalendar, day: Date): Date {
  const d = new Date(day);
  d.setHours(cal.startHour, cal.startMinute, 0, 0);
  return d;
}

function shiftEnd(cal: WorkingCalendar, day: Date): Date {
  return new Date(shiftStart(cal, day).getTime() + cal.minutesPerDay * 60_000);
}

function nextDayStart(t: Date): Date {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function previousDayEnd(cal: WorkingCalendar, t: Date): Date {
  const d = new Date(t);
  d.setDate(d.getDate() - 1);
  return shiftEnd(cal, d);
}

function isWorkingDay(cal: WorkingCalendar, d: Date): boolean {
  return cal.workingDays.includes(d.getDay());
}

/** The first working moment at or after `t`. */
export function alignForward(cal: WorkingCalendar, t: Date): Date {
  let d = new Date(t);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (isWorkingDay(cal, d)) {
      const start = shiftStart(cal, d);
      const end = shiftEnd(cal, d);
      if (d < start) return start;
      if (d < end) return d;
    }
    d = nextDayStart(d);
  }
  return d;
}

/** The last working moment at or before `t`. */
export function alignBackward(cal: WorkingCalendar, t: Date): Date {
  let d = new Date(t);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (isWorkingDay(cal, d)) {
      const start = shiftStart(cal, d);
      const end = shiftEnd(cal, d);
      if (d > end) return end;
      if (d > start) return d;
    }
    d = previousDayEnd(cal, d);
    if (isWorkingDay(cal, d)) return d;
  }
  return d;
}

export function addWorkingMinutes(cal: WorkingCalendar, from: Date, minutes: number): Date {
  let t = alignForward(cal, from);
  let remaining = minutes;
  for (let i = 0; i < MAX_DAYS && remaining > 0; i++) {
    const end = shiftEnd(cal, t);
    const available = (end.getTime() - t.getTime()) / 60_000;
    if (remaining <= available) return new Date(t.getTime() + remaining * 60_000);
    remaining -= available;
    t = alignForward(cal, nextDayStart(t));
  }
  return t;
}

export function subtractWorkingMinutes(cal: WorkingCalendar, from: Date, minutes: number): Date {
  let t = alignBackward(cal, from);
  let remaining = minutes;
  for (let i = 0; i < MAX_DAYS && remaining > 0; i++) {
    const start = shiftStart(cal, t);
    const available = (t.getTime() - start.getTime()) / 60_000;
    if (remaining <= available) return new Date(t.getTime() - remaining * 60_000);
    remaining -= available;
    t = alignBackward(cal, previousDayEnd(cal, t));
  }
  return t;
}

/** Working minutes between two instants. Negative when `to` precedes `from`. */
export function workingMinutesBetween(cal: WorkingCalendar, from: Date, to: Date): number {
  if (to < from) return -workingMinutesBetween(cal, to, from);
  let t = alignForward(cal, from);
  const end = alignForward(cal, to);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    if (t >= end) return total;
    const dayEnd = shiftEnd(cal, t);
    if (end <= dayEnd) return total + (end.getTime() - t.getTime()) / 60_000;
    total += (dayEnd.getTime() - t.getTime()) / 60_000;
    t = alignForward(cal, nextDayStart(t));
  }
  return total;
}

/**
 * Turn what a date picker gives you into a deadline a factory can miss.
 *
 * `<input type="date">` yields "2026-09-30", which `new Date()` reads as UTC
 * midnight — a moment before the shift it names has started. Taken literally that
 * silently costs the order a whole day. A due date with no time means the end of
 * that working day, so that is what this returns. A value that already carries a
 * time is left alone; somebody meant it.
 */
export function dueDateFromInput(
  value: string | null | undefined,
  cal: WorkingCalendar = DEFAULT_CALENDAR
): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!dateOnly) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, y, m, d] = dateOnly;
  const local = new Date(Number(y), Number(m) - 1, Number(d));
  return shiftEnd(cal, local);
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export type SchedulableTask = {
  id: number;
  workOrderId: number;
  stationId: number | null;
  expectedMinutes: number | null;
  status: "PENDING" | "IN_PROGRESS" | "DONE" | "BLOCKED";
  startedAt: Date | null;
  completedAt: Date | null;
  sequence: number;
};

export type SchedulableOrder = {
  id: number;
  orderNumber: string;
  dueDate: Date | null;
  /** Roots the whole tree on the top-level order's due date. */
  rootOrderId: number;
};

/** One directed edge: `taskId` cannot start until `dependsOnTaskId` is finished. */
export type SchedulableEdge = {
  taskId: number;
  dependsOnTaskId: number;
};

export type ScheduledTask = {
  taskId: number;
  workOrderId: number;
  stationId: number | null;
  durationMinutes: number;
  /** True when the duration was guessed because the step carries no estimate. */
  estimated: boolean;
  earliestStart: Date;
  earliestFinish: Date;
  latestStart: Date;
  latestFinish: Date;
  slackMinutes: number;
  critical: boolean;
  done: boolean;
};

export type ScheduledOrder = {
  workOrderId: number;
  orderNumber: string;
  dueDate: Date | null;
  projectedFinish: Date;
  /** Positive = late by this many working minutes. Null when there is no due date. */
  lateByMinutes: number | null;
};

export type Schedule = {
  computedAt: Date;
  tasks: Map<number, ScheduledTask>;
  orders: Map<number, ScheduledOrder>;
  /** How many steps had no estimate and were scheduled on a default. */
  guessedDurations: number;
};

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export function computeSchedule(input: {
  tasks: SchedulableTask[];
  orders: SchedulableOrder[];
  edges: SchedulableEdge[];
  stationCapacity: Map<number, number>;
  now: Date;
  calendar?: WorkingCalendar;
}): Schedule {
  const cal = input.calendar ?? DEFAULT_CALENDAR;
  const now = input.now;
  const orderById = new Map(input.orders.map((o) => [o.id, o]));

  const predecessors = new Map<number, number[]>();
  const successors = new Map<number, number[]>();
  for (const e of input.edges) {
    if (!predecessors.has(e.taskId)) predecessors.set(e.taskId, []);
    predecessors.get(e.taskId)!.push(e.dependsOnTaskId);
    if (!successors.has(e.dependsOnTaskId)) successors.set(e.dependsOnTaskId, []);
    successors.get(e.dependsOnTaskId)!.push(e.taskId);
  }

  const duration = (t: SchedulableTask) => {
    if (t.status === "DONE") return 0;
    const full = t.expectedMinutes ?? DEFAULT_TASK_MINUTES;
    if (t.status !== "IN_PROGRESS" || !t.startedAt) return full;
    // Credit the time already spent, but never claim a running job is finished.
    const spent = workingMinutesBetween(cal, t.startedAt, now);
    return Math.max(full - spent, 1);
  };

  /** A task's due date is its top-level order's — a sub-assembly inherits it. */
  const dueOf = (t: SchedulableTask): Date | null => {
    const order = orderById.get(t.workOrderId);
    if (!order) return null;
    return orderById.get(order.rootOrderId)?.dueDate ?? order.dueDate;
  };

  // --- Forward pass: list scheduling against station capacity ---------------
  const scheduled = new Map<number, { start: Date; finish: Date; minutes: number }>();
  const freeSlots = new Map<number, Date[]>();
  const slotsFor = (stationId: number): Date[] => {
    let slots = freeSlots.get(stationId);
    if (!slots) {
      const n = Math.max(1, input.stationCapacity.get(stationId) ?? 1);
      slots = Array.from({ length: n }, () => new Date(now));
      freeSlots.set(stationId, slots);
    }
    return slots;
  };

  // Work already finished occupies no machine; it only constrains its successors.
  const remaining: SchedulableTask[] = [];
  for (const t of input.tasks) {
    if (t.status === "DONE") {
      const finish = t.completedAt ?? now;
      scheduled.set(t.id, { start: t.startedAt ?? finish, finish, minutes: 0 });
    } else {
      remaining.push(t);
    }
  }

  const pending = new Set(remaining.map((t) => t.id));
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  let guessed = 0;

  while (pending.size > 0) {
    const ready = remaining.filter(
      (t) =>
        pending.has(t.id) &&
        (predecessors.get(t.id) ?? []).every((p) => !pending.has(p))
    );

    // A cycle, or an edge onto a task outside this input. Schedule what is left
    // in sequence order rather than hanging: a wrong date beats no screen.
    const batch = ready.length > 0 ? ready : remaining.filter((t) => pending.has(t.id));

    batch.sort((a, b) => {
      const da = dueOf(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const db = dueOf(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      if (a.workOrderId !== b.workOrderId) return a.workOrderId - b.workOrderId;
      return a.sequence - b.sequence;
    });

    const task = batch[0];
    pending.delete(task.id);

    if (task.expectedMinutes == null && task.status !== "DONE") guessed++;
    const minutes = duration(task);

    let earliest = new Date(now);
    for (const p of predecessors.get(task.id) ?? []) {
      const pf = scheduled.get(p)?.finish;
      if (pf && pf > earliest) earliest = pf;
    }

    // A station with capacity N runs N jobs at once; take whichever bay frees first.
    let start: Date;
    if (task.stationId == null) {
      start = alignForward(cal, earliest);
      scheduled.set(task.id, { start, finish: addWorkingMinutes(cal, start, minutes), minutes });
    } else {
      const slots = slotsFor(task.stationId);
      let best = 0;
      for (let i = 1; i < slots.length; i++) if (slots[i] < slots[best]) best = i;
      start = alignForward(cal, slots[best] > earliest ? slots[best] : earliest);
      const finish = addWorkingMinutes(cal, start, minutes);
      slots[best] = finish;
      scheduled.set(task.id, { start, finish, minutes });
    }
  }

  // --- Order projections ----------------------------------------------------
  const orderFinish = new Map<number, Date>();
  for (const t of input.tasks) {
    const s = scheduled.get(t.id);
    if (!s) continue;
    const order = orderById.get(t.workOrderId);
    const rootId = order?.rootOrderId ?? t.workOrderId;
    const current = orderFinish.get(rootId);
    if (!current || s.finish > current) orderFinish.set(rootId, s.finish);
  }

  const orders = new Map<number, ScheduledOrder>();
  for (const o of input.orders) {
    const projected = orderFinish.get(o.id);
    if (!projected) continue;
    orders.set(o.id, {
      workOrderId: o.id,
      orderNumber: o.orderNumber,
      dueDate: o.dueDate,
      projectedFinish: projected,
      lateByMinutes: o.dueDate ? workingMinutesBetween(cal, o.dueDate, projected) : null,
    });
  }

  // --- Backward pass: latest start, slack, critical path --------------------
  // A chain with no due date is measured against its own projected finish, so
  // slack still identifies the critical path even when nobody has promised a date.
  const latestFinish = new Map<number, Date>();
  const byFinishDesc = [...scheduled.keys()].sort(
    (a, b) => scheduled.get(b)!.finish.getTime() - scheduled.get(a)!.finish.getTime()
  );

  for (const id of byFinishDesc) {
    const task = byId.get(id);
    if (!task) continue;
    const succ = (successors.get(id) ?? []).filter((s) => scheduled.has(s));
    let lf: Date;
    if (succ.length === 0) {
      const o = orderById.get(task.workOrderId);
      const rootId = o?.rootOrderId ?? task.workOrderId;
      lf = orderById.get(rootId)?.dueDate ?? orderFinish.get(rootId) ?? scheduled.get(id)!.finish;
    } else {
      lf = new Date(8.64e15);
      for (const s of succ) {
        const sTask = byId.get(s);
        const sLatestFinish = latestFinish.get(s);
        if (!sTask || !sLatestFinish) continue;
        const sStart = subtractWorkingMinutes(cal, sLatestFinish, scheduled.get(s)!.minutes);
        if (sStart < lf) lf = sStart;
      }
      if (lf.getTime() === 8.64e15) lf = scheduled.get(id)!.finish;
    }
    latestFinish.set(id, lf);
  }

  const tasks = new Map<number, ScheduledTask>();
  for (const t of input.tasks) {
    const s = scheduled.get(t.id);
    if (!s) continue;
    const lf = latestFinish.get(t.id) ?? s.finish;
    const ls = subtractWorkingMinutes(cal, lf, s.minutes);
    const slack = workingMinutesBetween(cal, s.start, ls);
    tasks.set(t.id, {
      taskId: t.id,
      workOrderId: t.workOrderId,
      stationId: t.stationId,
      durationMinutes: s.minutes,
      estimated: t.expectedMinutes == null && t.status !== "DONE",
      earliestStart: s.start,
      earliestFinish: s.finish,
      latestStart: ls,
      latestFinish: lf,
      slackMinutes: slack,
      critical: slack <= 0,
      done: t.status === "DONE",
    });
  }

  return { computedAt: now, tasks, orders, guessedDurations: guessed };
}

// ---------------------------------------------------------------------------
// Late-risk root causes
// ---------------------------------------------------------------------------

export type LateRootCause = {
  taskId: number;
  workOrderId: number;
  /**
   * LATE    — the latest start is already behind us; the order is losing time now.
   * AT_RISK — still recoverable, but the margin is under the threshold.
   */
  severity: "LATE" | "AT_RISK";
  /** Working minutes past the latest start. Negative on AT_RISK: minutes still left. */
  lateByMinutes: number;
  /** How many not-yet-done steps sit downstream of this one. */
  blocking: number;
};

/**
 * The steps that are actually causing lateness — not every step suffering from it.
 *
 * A step is late when it has passed its latest start and has not begun. Waiting on
 * a predecessor is NOT late; that is ordinary sequencing, and alerting on it trains
 * people to ignore alerts. But one late frame weld makes every step behind it late
 * too, so a late step whose own predecessor is also late is a symptom, not a cause,
 * and is left out. What comes back is the head of each troubled chain.
 *
 * AT_RISK uses the same root-cause filter, so a step is only flagged if nothing
 * upstream of it is already in trouble.
 */
export function lateRootCauses(
  schedule: Schedule,
  tasks: SchedulableTask[],
  edges: SchedulableEdge[],
  now: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
  atRiskThresholdMinutes: number = AT_RISK_THRESHOLD_MINUTES
): LateRootCause[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const successors = new Map<number, number[]>();
  const predecessors = new Map<number, number[]>();
  for (const e of edges) {
    if (!successors.has(e.dependsOnTaskId)) successors.set(e.dependsOnTaskId, []);
    successors.get(e.dependsOnTaskId)!.push(e.taskId);
    if (!predecessors.has(e.taskId)) predecessors.set(e.taskId, []);
    predecessors.get(e.taskId)!.push(e.dependsOnTaskId);
  }

  /** Work in hand is not at risk of being started late — it has started. */
  const eligible = (id: number) => {
    const s = schedule.tasks.get(id);
    const t = byId.get(id);
    if (!s || !t) return null;
    if (t.status === "DONE" || t.status === "IN_PROGRESS") return null;
    return s;
  };

  const severityOf = (id: number): "LATE" | "AT_RISK" | null => {
    const s = eligible(id);
    if (!s) return null;
    if (now > s.latestStart) return "LATE";
    const margin = workingMinutesBetween(calendar, now, s.latestStart);
    return margin < atRiskThresholdMinutes ? "AT_RISK" : null;
  };

  const downstream = (id: number): number => {
    const seen = new Set<number>();
    const stack = [...(successors.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const t = byId.get(next);
      if (t && t.status === "DONE") continue;
      stack.push(...(successors.get(next) ?? []));
    }
    return seen.size;
  };

  const causes: LateRootCause[] = [];
  for (const t of tasks) {
    const severity = severityOf(t.id);
    if (!severity) continue;
    // Somebody upstream is already in trouble; they are the cause, not this step.
    if ((predecessors.get(t.id) ?? []).some((p) => severityOf(p) !== null)) continue;
    const s = schedule.tasks.get(t.id)!;
    causes.push({
      taskId: t.id,
      workOrderId: t.workOrderId,
      severity,
      lateByMinutes: Math.round(
        severity === "LATE"
          ? workingMinutesBetween(calendar, s.latestStart, now)
          : -workingMinutesBetween(calendar, now, s.latestStart)
      ),
      blocking: downstream(t.id),
    });
  }

  return causes.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "LATE" ? -1 : 1) ||
      b.blocking - a.blocking ||
      b.lateByMinutes - a.lateByMinutes
  );
}
