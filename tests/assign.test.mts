import "dotenv/config";
import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import {
  items,
  users,
  stations,
  workOrders,
  workOrderTasks,
  routingSteps,
  taskEvents,
  alerts,
  inventoryLocations,
} from "../src/db/schema.ts";
import { resetDatabase } from "./helpers.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

/*
 * Handing a step to a named person.
 *
 * Two things are worth testing and neither is the happy path. First that giving
 * someone a step is itself permission to start it, wherever they normally work —
 * this is how a supervisor moves one person to another station for one job, and
 * it used to be refused outright. Second the alert audience: reassigning must stop
 * telling the previous person to do it, and must not copy the news to everyone
 * standing near them.
 */

type Session = {
  id: number;
  name: string;
  email: string;
  role: "WORKER" | "SUPERVISOR" | "ADMIN";
  stationId: number | null;
};

let sessionUser: Session | null = null;

mock.module("../src/lib/session.ts", {
  namedExports: {
    getCurrentUser: async () => sessionUser,
    requireUser: async () => {
      if (!sessionUser) throw new Error("Not signed in");
      return sessionUser;
    },
    requireRole: async (...roles: string[]) => {
      if (!sessionUser) throw new Error("Not signed in");
      if (!roles.includes(sessionUser.role)) throw new Error("Insufficient role");
      return sessionUser;
    },
    isManager: (role: string) => role === "SUPERVISOR" || role === "ADMIN",
  },
});

mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

let assignTask: typeof import("../src/app/actions/tasks.ts").assignTask;
let startTask: typeof import("../src/app/actions/tasks.ts").startTask;
let completeTask: typeof import("../src/app/actions/tasks.ts").completeTask;
let alertsFor: typeof import("../src/lib/alerts.ts").alertsFor;

before(async () => {
  ({ assignTask, completeTask, startTask } = await import("../src/app/actions/tasks.ts"));
  ({ alertsFor } = await import("../src/lib/alerts.ts"));
});

after(async () => {
  await pool.end();
});

let TASK = 0;
let FRAME_STATION = 0;
let COIL_STATION = 0;
let ANNA = 0; // worker at Frame Fab — the right person for this step
let DEV = 0; // worker at Coil Line — the wrong station
let SUPERVISOR: Session;

beforeEach(async () => {
  await resetDatabase();

  // startTask needs somewhere to draw material from, even when the step needs none.
  await db.insert(inventoryLocations).values({ code: "STORES", name: "Main stores" });

  const [frame] = await db.insert(stations).values({ name: "Frame Fab" }).returning();
  const [coil] = await db.insert(stations).values({ name: "Coil Line" }).returning();
  FRAME_STATION = frame.id;
  COIL_STATION = coil.id;

  const [anna] = await db
    .insert(users)
    .values({
      name: "Anna Reyes",
      email: "anna@thermal-corp.com",
      passwordHash: "x",
      role: "WORKER",
      stationId: frame.id,
    })
    .returning();
  ANNA = anna.id;

  const [dev] = await db
    .insert(users)
    .values({
      name: "Dev Patel",
      email: "dev@thermal-corp.com",
      passwordHash: "x",
      role: "WORKER",
      stationId: coil.id,
    })
    .returning();
  DEV = dev.id;

  const [sup] = await db
    .insert(users)
    .values({
      name: "Tom Alvarez",
      email: "tom@thermal-corp.com",
      passwordHash: "x",
      role: "SUPERVISOR",
      stationId: null,
    })
    .returning();
  SUPERVISOR = {
    id: sup.id,
    name: sup.name,
    email: sup.email,
    role: "SUPERVISOR",
    stationId: null,
  };
  sessionUser = SUPERVISOR;

  const [unit] = await db
    .insert(items)
    .values({ sku: "AHU-3000", name: "Air Handler 3000", procurementType: "MANUFACTURED" })
    .returning();

  const [step] = await db
    .insert(routingSteps)
    .values({
      itemId: unit.id,
      sequence: 1,
      name: "Cut and form frame",
      stationId: frame.id,
      expectedMinutes: 90,
    })
    .returning();

  const [wo] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-3100", itemId: unit.id, quantity: 1, status: "RELEASED" })
    .returning();

  const [task] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: wo.id,
      routingStepId: step.id,
      sequence: 1,
      name: "Cut and form frame",
      stationId: frame.id,
      expectedMinutes: 90,
    })
    .returning();
  TASK = task.id;
});

const taskRow = async () => {
  const [t] = await db.select().from(workOrderTasks).where(eq(workOrderTasks.id, TASK));
  return t;
};

const openAlerts = async () =>
  db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workOrderTaskId, TASK), isNull(alerts.acknowledgedAt)));

// ===========================================================================

test("A1 a supervisor can give a step to someone at that station", async () => {
  const res = await assignTask(TASK, ANNA);
  assert.equal(res.ok, true);

  const t = await taskRow();
  assert.equal(t.assignedToUserId, ANNA);
  assert.equal(t.assignedByUserId, SUPERVISOR.id);
  assert.ok(t.assignedAt, "assignedAt should be stamped");
});

test("A2 a worker cannot hand work out", async () => {
  sessionUser = {
    id: ANNA,
    name: "Anna Reyes",
    email: "anna@thermal-corp.com",
    role: "WORKER",
    stationId: FRAME_STATION,
  };
  const res = await assignTask(TASK, ANNA);
  assert.equal(res.ok, false);

  const t = await taskRow();
  assert.equal(t.assignedToUserId, null);
});

test("A3 someone from another station CAN be given the step, and can then start it", async () => {
  // This is how one person is moved to another station for one job. Dev works at
  // Coil Line; the step is at Frame Fab. It used to be refused, because the start
  // guard would then have blocked him — a worker was permanently welded to one
  // station. Being handed a step by name is now permission to begin it.
  const res = await assignTask(TASK, DEV);
  assert.equal(res.ok, true);
  assert.equal((await taskRow()).assignedToUserId, DEV);

  // The part that matters: it is not a dead end on his screen.
  sessionUser = {
    id: DEV,
    name: "Dev Kapoor",
    email: "dev@thermal-corp.com",
    role: "WORKER",
    stationId: COIL_STATION,
  };
  const started = await startTask(TASK, randomUUID());
  assert.equal(started.ok, true, `assignee could not start it: ${JSON.stringify(started)}`);
});

test("A3b an unassigned worker still cannot start another station's step", async () => {
  // The relaxation is exactly as wide as the assignment. Nothing else moved.
  sessionUser = {
    id: DEV,
    name: "Dev Kapoor",
    email: "dev@thermal-corp.com",
    role: "WORKER",
    stationId: COIL_STATION,
  };
  const started = await startTask(TASK, randomUUID());
  assert.equal(started.ok, false);
  assert.match((started as { error: string }).error, /another station/);
});

test("A4 a manager may be assigned anywhere, because they may act anywhere", async () => {
  const res = await assignTask(TASK, SUPERVISOR.id);
  assert.equal(res.ok, true);
  assert.equal((await taskRow()).assignedToUserId, SUPERVISOR.id);
});

test("A5 the person it was given to is told, and nobody else is", async () => {
  await assignTask(TASK, ANNA);

  const rows = await openAlerts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "ASSIGNED_TO_YOU");
  assert.equal(rows[0].audienceUserId, ANNA);
  // Critically NOT addressed to the station as well, or being handed a job would
  // notify everyone working beside you.
  assert.equal(rows[0].audienceStationId, null);

  const annaSees = await alertsFor({
    id: ANNA,
    name: "Anna Reyes",
    email: "anna@thermal-corp.com",
    role: "WORKER",
    stationId: FRAME_STATION,
  });
  assert.ok(annaSees.some((a) => a.kind === "ASSIGNED_TO_YOU"));

  const devSees = await alertsFor({
    id: DEV,
    name: "Dev Patel",
    email: "dev@thermal-corp.com",
    role: "WORKER",
    stationId: COIL_STATION,
  });
  assert.equal(devSees.some((a) => a.kind === "ASSIGNED_TO_YOU"), false);
});

test("A6 the supervisor who handed it out does not get a copy of the news", async () => {
  await assignTask(TASK, ANNA);
  const supSees = await alertsFor(SUPERVISOR);
  assert.equal(
    supSees.some((a) => a.kind === "ASSIGNED_TO_YOU"),
    false,
    "a supervisor would stop reading the feed if every handout came back to them"
  );
});

test("A7 reassigning stops telling the first person to do it", async () => {
  await assignTask(TASK, ANNA);
  await assignTask(TASK, SUPERVISOR.id);

  const rows = await openAlerts();
  assert.equal(rows.length, 1, "exactly one open assignment alert at a time");
  assert.equal(rows[0].audienceUserId, SUPERVISOR.id);

  const annaSees = await alertsFor({
    id: ANNA,
    name: "Anna Reyes",
    email: "anna@thermal-corp.com",
    role: "WORKER",
    stationId: FRAME_STATION,
  });
  assert.equal(annaSees.some((a) => a.kind === "ASSIGNED_TO_YOU"), false);
});

test("A8 taking a step back clears the assignment and the alert", async () => {
  await assignTask(TASK, ANNA);
  const res = await assignTask(TASK, null);
  assert.equal(res.ok, true);

  const t = await taskRow();
  assert.equal(t.assignedToUserId, null);
  assert.equal(t.assignedByUserId, null);
  assert.equal(t.assignedAt, null);
  assert.equal((await openAlerts()).length, 0);
});

test("A9 re-confirming the same person changes nothing and raises no second alert", async () => {
  await assignTask(TASK, ANNA);
  const before = await db.select().from(taskEvents).where(eq(taskEvents.workOrderTaskId, TASK));

  await assignTask(TASK, ANNA);
  const after = await db.select().from(taskEvents).where(eq(taskEvents.workOrderTaskId, TASK));

  assert.equal(after.length, before.length, "a no-op assignment should not write an event");
  assert.equal((await openAlerts()).length, 1);
});

test("A10 every assignment is on the audit trail with both names", async () => {
  await assignTask(TASK, ANNA);
  const events = await db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.workOrderTaskId, TASK), eq(taskEvents.type, "ASSIGNED")));

  assert.equal(events.length, 1);
  assert.equal(events[0].actorUserId, SUPERVISOR.id);
  const payload = events[0].payload as { assignedToUserId: number; assignedToName: string };
  assert.equal(payload.assignedToUserId, ANNA);
  assert.equal(payload.assignedToName, "Anna Reyes");
});

test("A11 a finished step cannot be handed to anyone", async () => {
  sessionUser = {
    id: ANNA,
    name: "Anna Reyes",
    email: "anna@thermal-corp.com",
    role: "WORKER",
    stationId: FRAME_STATION,
  };
  await completeTask(TASK);
  sessionUser = SUPERVISOR;

  const res = await assignTask(TASK, ANNA);
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /already finished/i);
});

test("A12 completing a step closes the alert asking someone to do it", async () => {
  await assignTask(TASK, ANNA);
  assert.equal((await openAlerts()).length, 1);

  sessionUser = {
    id: ANNA,
    name: "Anna Reyes",
    email: "anna@thermal-corp.com",
    role: "WORKER",
    stationId: FRAME_STATION,
  };
  await completeTask(TASK);

  // Otherwise Anna's feed keeps asking her to start something she has finished,
  // and it can never come true again.
  assert.equal((await openAlerts()).length, 0);
});

test("A13 an inactive person cannot be given work", async () => {
  await db.update(users).set({ active: false }).where(eq(users.id, ANNA));
  const res = await assignTask(TASK, ANNA);
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not active/i);
});
