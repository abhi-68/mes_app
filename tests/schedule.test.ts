import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CALENDAR,
  addWorkingMinutes,
  subtractWorkingMinutes,
  workingMinutesBetween,
  dueDateFromInput,
  computeSchedule,
  lateRootCauses,
  type SchedulableTask,
  type SchedulableOrder,
  type SchedulableEdge,
} from "../src/lib/schedule";

/*
  Pure scheduling maths — no database. Dates are local, matching the calendar,
  which is what a shift is.

  Reference week: 2026-03-02 is a Monday. Shift is 07:00 + 480 minutes = 15:00.
*/

const MON_07 = new Date(2026, 2, 2, 7, 0, 0, 0);
const MON_14 = new Date(2026, 2, 2, 14, 0, 0, 0);
const FRI_07 = new Date(2026, 2, 6, 7, 0, 0, 0);

function task(over: Partial<SchedulableTask> & { id: number }): SchedulableTask {
  return {
    workOrderId: 1,
    stationId: 1,
    expectedMinutes: 60,
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    sequence: over.id,
    ...over,
  };
}

const order = (over: Partial<SchedulableOrder> & { id: number }): SchedulableOrder => ({
  orderNumber: `ORD-${over.id}`,
  dueDate: null,
  rootOrderId: over.id,
  ...over,
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

test("work does not happen after the shift ends", () => {
  // 120 minutes from 14:00 spans the shift boundary: 1 hour today, 1 tomorrow.
  const end = addWorkingMinutes(DEFAULT_CALENDAR, MON_14, 120);
  assert.equal(end.getDate(), 3, "should land on Tuesday");
  assert.equal(end.getHours(), 8);
});

test("work does not happen at the weekend", () => {
  // Friday 07:00 + a full day + one more hour lands on Monday, not Saturday.
  const end = addWorkingMinutes(DEFAULT_CALENDAR, FRI_07, 480 + 60);
  assert.equal(end.getDay(), 1, "should land on a Monday");
  assert.equal(end.getHours(), 8);
});

test("a start before the shift waits for the shift", () => {
  const sixAm = new Date(2026, 2, 2, 6, 0, 0, 0);
  const end = addWorkingMinutes(DEFAULT_CALENDAR, sixAm, 60);
  assert.equal(end.getHours(), 8, "should start at 07:00, not 06:00");
});

test("subtracting working minutes is the inverse of adding", () => {
  const end = addWorkingMinutes(DEFAULT_CALENDAR, MON_07, 900);
  const back = subtractWorkingMinutes(DEFAULT_CALENDAR, end, 900);
  assert.equal(back.getTime(), MON_07.getTime());
});

test("working minutes between skips nights and weekends", () => {
  // Monday 07:00 to Friday 07:00 is four working days, not four calendar days
  // of 24 hours.
  assert.equal(workingMinutesBetween(DEFAULT_CALENDAR, MON_07, FRI_07), 4 * 480);
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

test("one machine runs two jobs back to back", () => {
  const s = computeSchedule({
    tasks: [
      task({ id: 1, expectedMinutes: 120 }),
      task({ id: 2, workOrderId: 2, expectedMinutes: 120 }),
    ],
    orders: [order({ id: 1 }), order({ id: 2 })],
    edges: [],
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });

  const a = s.tasks.get(1)!;
  const b = s.tasks.get(2)!;
  assert.equal(a.earliestStart.getHours(), 7);
  assert.equal(b.earliestStart.getHours(), 9, "second job waits for the machine");
});

test("two machines run two jobs at once", () => {
  const s = computeSchedule({
    tasks: [
      task({ id: 1, expectedMinutes: 120 }),
      task({ id: 2, workOrderId: 2, expectedMinutes: 120 }),
    ],
    orders: [order({ id: 1 }), order({ id: 2 })],
    edges: [],
    stationCapacity: new Map([[1, 2]]),
    now: MON_07,
  });

  assert.equal(s.tasks.get(1)!.earliestStart.getHours(), 7);
  assert.equal(s.tasks.get(2)!.earliestStart.getHours(), 7, "second machine is free");
});

test("capacity is per station, not shared across the plant", () => {
  const s = computeSchedule({
    tasks: [
      task({ id: 1, stationId: 1, expectedMinutes: 120 }),
      task({ id: 2, stationId: 2, workOrderId: 2, expectedMinutes: 120 }),
    ],
    orders: [order({ id: 1 }), order({ id: 2 })],
    edges: [],
    stationCapacity: new Map([
      [1, 1],
      [2, 1],
    ]),
    now: MON_07,
  });

  assert.equal(s.tasks.get(1)!.earliestStart.getHours(), 7);
  assert.equal(s.tasks.get(2)!.earliestStart.getHours(), 7);
});

// ---------------------------------------------------------------------------
// Dependencies and the critical path
// ---------------------------------------------------------------------------

test("a dependent step waits for its predecessor even on a free machine", () => {
  const edges: SchedulableEdge[] = [{ taskId: 2, dependsOnTaskId: 1 }];
  const s = computeSchedule({
    tasks: [task({ id: 1, expectedMinutes: 120 }), task({ id: 2, expectedMinutes: 60 })],
    orders: [order({ id: 1 })],
    edges,
    stationCapacity: new Map([[1, 5]]),
    now: MON_07,
  });

  assert.equal(s.tasks.get(2)!.earliestStart.getHours(), 9);
});

test("parallel branches both start immediately, and only the long one is critical", () => {
  // 1 -> 3 and 2 -> 3. Branch 1 is longer, so branch 2 carries slack.
  const edges: SchedulableEdge[] = [
    { taskId: 3, dependsOnTaskId: 1 },
    { taskId: 3, dependsOnTaskId: 2 },
  ];
  const s = computeSchedule({
    tasks: [
      task({ id: 1, stationId: 1, expectedMinutes: 240 }),
      task({ id: 2, stationId: 2, expectedMinutes: 60 }),
      task({ id: 3, stationId: 3, expectedMinutes: 60 }),
    ],
    orders: [order({ id: 1 })],
    edges,
    stationCapacity: new Map([
      [1, 1],
      [2, 1],
      [3, 1],
    ]),
    now: MON_07,
  });

  assert.equal(s.tasks.get(1)!.earliestStart.getHours(), 7);
  assert.equal(s.tasks.get(2)!.earliestStart.getHours(), 7);
  assert.equal(s.tasks.get(3)!.earliestStart.getHours(), 11, "waits for the long branch");

  assert.equal(s.tasks.get(1)!.critical, true);
  assert.equal(s.tasks.get(3)!.critical, true);
  assert.equal(s.tasks.get(2)!.slackMinutes, 180, "short branch can slip three hours");
  assert.equal(s.tasks.get(2)!.critical, false);
});

test("a sub-assembly holds up the parent it feeds", () => {
  // Child order 2's last step feeds order 1's assembly step.
  const edges: SchedulableEdge[] = [{ taskId: 10, dependsOnTaskId: 20 }];
  const s = computeSchedule({
    tasks: [
      task({ id: 10, workOrderId: 1, stationId: 1, expectedMinutes: 60 }),
      task({ id: 20, workOrderId: 2, stationId: 2, expectedMinutes: 300 }),
    ],
    orders: [order({ id: 1 }), order({ id: 2, rootOrderId: 1 })],
    edges,
    stationCapacity: new Map([
      [1, 1],
      [2, 1],
    ]),
    now: MON_07,
  });

  assert.equal(s.tasks.get(10)!.earliestStart.getHours(), 12);
});

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

test("an order that fits reports no lateness", () => {
  const due = new Date(2026, 2, 6, 15, 0, 0, 0);
  const s = computeSchedule({
    tasks: [task({ id: 1, expectedMinutes: 120 })],
    orders: [order({ id: 1, dueDate: due })],
    edges: [],
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });

  assert.ok(s.orders.get(1)!.lateByMinutes! < 0, "finishes before it is due");
});

test("capacity is what makes an order late", () => {
  // Five one-day jobs at one station cannot finish by Wednesday. With five
  // machines they can. This is the whole argument for finite capacity.
  const tasks = [1, 2, 3, 4, 5].map((id) =>
    task({ id, workOrderId: id, expectedMinutes: 480 })
  );
  const orders = [1, 2, 3, 4, 5].map((id) =>
    order({ id, dueDate: new Date(2026, 2, 4, 15, 0, 0, 0) })
  );

  const tight = computeSchedule({
    tasks,
    orders,
    edges: [],
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });
  assert.ok(tight.orders.get(5)!.lateByMinutes! > 0, "one machine cannot do it");

  const wide = computeSchedule({
    tasks,
    orders,
    edges: [],
    stationCapacity: new Map([[1, 5]]),
    now: MON_07,
  });
  assert.ok(wide.orders.get(5)!.lateByMinutes! <= 0, "five machines can");
});

test("steps with no estimate are counted, not hidden", () => {
  const s = computeSchedule({
    tasks: [task({ id: 1, expectedMinutes: null }), task({ id: 2, expectedMinutes: 60 })],
    orders: [order({ id: 1 })],
    edges: [],
    stationCapacity: new Map([[1, 2]]),
    now: MON_07,
  });

  assert.equal(s.guessedDurations, 1);
  assert.equal(s.tasks.get(1)!.estimated, true);
  assert.equal(s.tasks.get(2)!.estimated, false);
});

test("finished work occupies no machine", () => {
  const s = computeSchedule({
    tasks: [
      task({
        id: 1,
        status: "DONE",
        expectedMinutes: 480,
        completedAt: new Date(2026, 2, 2, 6, 0, 0, 0),
      }),
      task({ id: 2, expectedMinutes: 60 }),
    ],
    orders: [order({ id: 1 })],
    edges: [{ taskId: 2, dependsOnTaskId: 1 }],
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });

  assert.equal(s.tasks.get(2)!.earliestStart.getHours(), 7, "not queued behind finished work");
});

// ---------------------------------------------------------------------------
// Late-risk root causes
// ---------------------------------------------------------------------------

test("waiting for a predecessor is not an alert", () => {
  // Nothing has slipped. Step 2 is merely queued behind step 1.
  const tasks = [task({ id: 1, expectedMinutes: 120 }), task({ id: 2, expectedMinutes: 120 })];
  const edges: SchedulableEdge[] = [{ taskId: 2, dependsOnTaskId: 1 }];
  const s = computeSchedule({
    tasks,
    orders: [order({ id: 1, dueDate: FRI_07 })],
    edges,
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });

  assert.deepEqual(lateRootCauses(s, tasks, edges, MON_07), []);
});

test("a late chain reports its head, not every step suffering from it", () => {
  // A four-step chain of full days against a due date one day out: every step
  // is past its latest start, but only the first is the cause.
  const tasks = [1, 2, 3, 4].map((id) => task({ id, expectedMinutes: 480 }));
  const edges: SchedulableEdge[] = [
    { taskId: 2, dependsOnTaskId: 1 },
    { taskId: 3, dependsOnTaskId: 2 },
    { taskId: 4, dependsOnTaskId: 3 },
  ];
  const s = computeSchedule({
    tasks,
    orders: [order({ id: 1, dueDate: new Date(2026, 2, 3, 15, 0, 0, 0) })],
    edges,
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });

  const causes = lateRootCauses(s, tasks, edges, MON_07);
  assert.equal(causes.length, 1, "one cause, not four alerts");
  assert.equal(causes[0].taskId, 1);
  assert.equal(causes[0].severity, "LATE");
  assert.equal(causes[0].blocking, 3, "names how much is held up behind it");
});

// ---------------------------------------------------------------------------
// Early warning
// ---------------------------------------------------------------------------

test("a warning comes BEFORE the latest start, not after it", () => {
  // Two full days of work due end of Wednesday, so the chain has to start by
  // Tuesday 07:00. At Monday 14:00 there is one hour of margin left — nothing
  // has been missed yet, and that is exactly when somebody should be told.
  const tasks = [1, 2].map((id) => task({ id, expectedMinutes: 480 }));
  const edges: SchedulableEdge[] = [{ taskId: 2, dependsOnTaskId: 1 }];
  const s = computeSchedule({
    tasks,
    orders: [order({ id: 1, dueDate: new Date(2026, 2, 4, 15, 0, 0, 0) })],
    edges,
    stationCapacity: new Map([[1, 1]]),
    now: MON_14,
  });

  const causes = lateRootCauses(s, tasks, edges, MON_14);
  assert.equal(causes.length, 1);
  assert.equal(causes[0].severity, "AT_RISK", "flagged while it can still be saved");
  assert.ok(causes[0].lateByMinutes < 0, "negative = minutes still in hand");
});

test("plenty of margin raises nothing at all", () => {
  const tasks = [task({ id: 1, expectedMinutes: 60 })];
  const s = computeSchedule({
    tasks,
    orders: [order({ id: 1, dueDate: new Date(2026, 2, 20, 15, 0, 0, 0) })],
    edges: [],
    stationCapacity: new Map([[1, 1]]),
    now: MON_07,
  });

  assert.deepEqual(lateRootCauses(s, tasks, [], MON_07), []);
});

test("a step already under way is neither late nor at risk", () => {
  // It has started. Warning someone that it might start late is noise.
  const tasks = [
    task({ id: 1, expectedMinutes: 480, status: "IN_PROGRESS", startedAt: MON_07 }),
  ];
  const s = computeSchedule({
    tasks,
    orders: [order({ id: 1, dueDate: new Date(2026, 2, 2, 8, 0, 0, 0) })],
    edges: [],
    stationCapacity: new Map([[1, 1]]),
    now: MON_14,
  });

  assert.deepEqual(lateRootCauses(s, tasks, [], MON_14), []);
});

// ---------------------------------------------------------------------------
// Due dates off a date picker
// ---------------------------------------------------------------------------

test("a date with no time means the END of that working day", () => {
  const due = dueDateFromInput("2026-03-06");
  assert.ok(due);
  assert.equal(due.getFullYear(), 2026);
  assert.equal(due.getMonth(), 2);
  assert.equal(due.getDate(), 6);
  assert.equal(due.getHours(), 15, "07:00 + 480 minutes, not midnight");
});

test("a due date that carries a time is left alone", () => {
  const due = dueDateFromInput("2026-03-06T09:30:00");
  assert.ok(due);
  assert.equal(due.getHours(), 9);
  assert.equal(due.getMinutes(), 30);
});

test("no due date stays no due date", () => {
  assert.equal(dueDateFromInput(null), null);
  assert.equal(dueDateFromInput(""), null);
});
