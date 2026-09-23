import "dotenv/config";
import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import {
  items,
  users,
  stations,
  workOrders,
  workOrderTasks,
  routingSteps,
  bomLines,
  inventoryLocations,
  inventoryBalances,
  inventoryMovements,
  materialRequirements,
  timeEntries,
  taskEvents,
  operationDependencies,
} from "../src/db/schema.ts";
import { resetDatabase, uid } from "./helpers.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

/*
 * Integration tests for the APPLICATION ACTION, not the engine.
 *
 * These exercise src/app/actions/tasks.ts — the same entry point the worker UI calls —
 * so they cover authorization, the single transaction spanning status/inventory/labour/
 * events, and the stable-command-id contract. Engine correctness is proven separately;
 * passing those tests says nothing about whether this boundary is wired up right.
 *
 * The server action reads the session, so it is stubbed per test.
 */

let sessionUser: {
  id: number;
  name: string;
  email: string;
  role: "WORKER" | "SUPERVISOR" | "ADMIN";
  stationId: number | null;
} | null = null;

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

// next/cache is a no-op outside a request scope.
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

// Imported after the session mock is installed, so the action picks up the stub.
let startTask: typeof import("../src/app/actions/tasks.ts").startTask;
let placeHold: typeof import("../src/lib/inventory.ts").placeHold;
let receiveStock: typeof import("../src/lib/inventory.ts").receiveStock;
let coverageFor: typeof import("../src/lib/inventory.ts").coverageFor;
let issueUnreserved: typeof import("../src/lib/inventory.ts").issueUnreserved;

before(async () => {
  ({ startTask } = await import("../src/app/actions/tasks.ts"));
  ({ placeHold, receiveStock, coverageFor, issueUnreserved } = await import(
    "../src/lib/inventory.ts"
  ));
});

let MOTOR = 0;
let STORES = 0;
let TASK = 0;
let REQ = 0;
let WORKER_ID = 0;
let OTHER_STATION = 0;

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();

  const [fanSection] = await db
    .insert(items)
    .values({ sku: "SUB-FAN-01", name: "Fan & Motor Section", procurementType: "MANUFACTURED" })
    .returning();
  const [motor] = await db
    .insert(items)
    .values({ sku: "BUY-MOTOR-5HP", name: "Motor, 5 HP", procurementType: "PURCHASED" })
    .returning();
  MOTOR = motor.id;

  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();
  STORES = stores.id;

  const [fanStation] = await db
    .insert(stations)
    .values({ name: "Fan & Motor Assembly" })
    .returning();
  const [coilStation] = await db.insert(stations).values({ name: "Coil Line" }).returning();
  OTHER_STATION = coilStation.id;

  const [worker] = await db
    .insert(users)
    .values({
      name: "Marcus Webb",
      email: "worker@thermal-corp.com",
      passwordHash: "x",
      role: "WORKER",
      stationId: fanStation.id,
    })
    .returning();
  WORKER_ID = worker.id;
  sessionUser = {
    id: worker.id,
    name: worker.name,
    email: worker.email,
    role: "WORKER",
    stationId: fanStation.id,
  };

  const [step] = await db
    .insert(routingSteps)
    .values({
      itemId: fanSection.id,
      sequence: 1,
      name: "Fit motor, sheaves & belts",
      stationId: fanStation.id,
      expectedMinutes: 45,
    })
    .returning();

  // One motor consumed at this step.
  await db.insert(bomLines).values({
    parentItemId: fanSection.id,
    componentItemId: MOTOR,
    quantity: 1,
    consumedAtRoutingStepId: step.id,
  });

  const [wo] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-2001", itemId: fanSection.id, quantity: 1, status: "RELEASED" })
    .returning();
  const [task] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: wo.id,
      routingStepId: step.id,
      sequence: 1,
      name: "Fit motor, sheaves & belts",
      stationId: fanStation.id,
      expectedMinutes: 45,
    })
    .returning();
  TASK = task.id;

  const [req] = await db
    .insert(materialRequirements)
    .values({ operationId: task.id, itemId: MOTOR, requiredQty: 1 })
    .returning();
  REQ = req.id;
});

const balance = async () => {
  const [row] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, MOTOR), eq(inventoryBalances.locationId, STORES)));
  return row ?? { onHand: 0, activeReserved: 0, heldQty: 0 };
};

const taskRow = async () => {
  const [t] = await db.select().from(workOrderTasks).where(eq(workOrderTasks.id, TASK));
  return t;
};

/** Stand in for the handler walking to the rack and scanning what they lifted. */
const collect = (quantity = 1) =>
  issueUnreserved({
    commandId: uid("pick"),
    requirementId: REQ,
    itemId: MOTOR,
    locationId: STORES,
    quantity,
  });

// ===========================================================================

test("a step will not start while its material is still on the rack", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });

  const res = await startTask(TASK, "cmd-uncollected");
  assert.equal(res.ok, false, "the stock is in the building, but not in their hands");
  if (!res.ok) {
    assert.match(res.error, /Collect the material first/);
    assert.equal(res.code, "MATERIAL_NOT_COLLECTED");
  }

  assert.equal((await balance()).onHand, 3, "nothing moved");
  assert.equal((await balance()).activeReserved, 0, "and nothing was committed either");
  assert.equal((await taskRow()).status, "PENDING");
  assert.equal(
    (await db.select().from(timeEntries).where(eq(timeEntries.workOrderTaskId, TASK))).length,
    0,
    "no clock started"
  );
});

test("successful start: material already collected, clock running, event written", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });
  await collect();

  const res = await startTask(TASK, "cmd-success-1");
  assert.equal(res.ok, true, res.ok ? "" : res.error);

  assert.equal((await balance()).onHand, 2, "the motor left the shelf when it was scanned");
  assert.equal((await coverageFor(REQ)).uncovered, 0);
  assert.equal((await taskRow()).status, "IN_PROGRESS");

  const clocks = await db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.workOrderTaskId, TASK));
  assert.equal(clocks.length, 1, "labour session opened");
  assert.equal(clocks[0].userId, WORKER_ID);

  const events = await db.select().from(taskEvents).where(eq(taskEvents.workOrderTaskId, TASK));
  assert.equal(events.length, 1, "one audit event");
  assert.equal(events[0].type, "STARTED");
});

test("duplicate request with the SAME command id opens one clock", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });
  await collect();

  // The worker taps Start, the response is lost, the worker taps again. The UI reuses
  // the command id, so the server must treat the second call as the same action.
  const a = await startTask(TASK, "cmd-dup-1");
  const b = await startTask(TASK, "cmd-dup-1");

  assert.equal(a.ok, true);
  assert.equal(b.ok, true, "a replay is not an error");
  assert.equal((await balance()).onHand, 2, "nothing drawn either time");
  assert.equal(
    (await db.select().from(timeEntries).where(eq(timeEntries.workOrderTaskId, TASK))).length,
    1,
    "ONE clock, not two"
  );
});

test("a NEW command id does not draw the material a second time", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });
  await collect();

  await startTask(TASK, "cmd-first");
  // A different id is a different command, but the requirement is already covered,
  // so coverage short-circuits and nothing further is drawn.
  await startTask(TASK, "cmd-second");

  assert.equal((await balance()).onHand, 2, "still just the one motor gone");
  assert.equal((await balance()).activeReserved, 0);
});

test("insufficient stock: task does not start and nothing is consumed", async () => {
  // No stock received at all.
  const res = await startTask(TASK, "cmd-short-1");

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /Short 1/, `useful message, got: ${res.error}`);
    assert.equal(res.code, "INSUFFICIENT_STOCK");
  }

  assert.equal((await taskRow()).status, "PENDING", "task must NOT advance");
  assert.equal((await balance()).onHand, 0);
  assert.equal(
    (await db.select().from(timeEntries).where(eq(timeEntries.workOrderTaskId, TASK))).length,
    0,
    "no clock started"
  );
  assert.equal(
    (await db.select().from(taskEvents).where(eq(taskEvents.workOrderTaskId, TASK))).length,
    0,
    "no event written"
  );
});

test("held stock: task does not start even though stock physically exists", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 2 });
  await placeHold({
    commandId: uid("hold"),
    itemId: MOTOR,
    locationId: STORES,
    quantity: 2,
    reason: "supplier certificate withdrawn",
  });

  const res = await startTask(TASK, "cmd-held-1");

  assert.equal(res.ok, false, "must refuse to draw held stock");
  assert.equal((await taskRow()).status, "PENDING");
  assert.equal((await balance()).onHand, 2, "stock untouched");
  assert.equal((await balance()).heldQty, 2);
});

test("rollback: a failure mid-action leaves no partial state", async () => {
  // Enough for the requirement, but we make the action fail after materials are issued
  // by removing the work order row the status update depends on... instead, provoke a
  // real failure: two requirements, the second short.
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 5 });

  const [gasket] = await db
    .insert(items)
    .values({ sku: "BUY-GASKET", name: "Gasket set", procurementType: "PURCHASED" })
    .returning();
  await db
    .insert(materialRequirements)
    .values({ operationId: TASK, itemId: gasket.id, requiredQty: 4 });
  // No gasket stock at all -> the action must fail on the second requirement.

  const res = await startTask(TASK, "cmd-rollback-1");
  assert.equal(res.ok, false, "second requirement is short");

  // The FIRST requirement's motor must have been rolled back with everything else.
  assert.equal((await balance()).onHand, 5, "motor issue rolled back");
  assert.equal((await balance()).activeReserved, 0, "reservation rolled back");
  assert.equal((await taskRow()).status, "PENDING", "task did not start");
  assert.equal(
    (await db.select().from(inventoryMovements).where(eq(inventoryMovements.type, "ISSUE")))
      .length,
    0,
    "no issue movement survived"
  );
  assert.equal(
    (await db.select().from(taskEvents).where(eq(taskEvents.workOrderTaskId, TASK))).length,
    0,
    "no event survived"
  );
});

test("authorization: a worker cannot start a step at another station", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });

  // Move the step to a station this worker is not assigned to.
  await db
    .update(workOrderTasks)
    .set({ stationId: OTHER_STATION })
    .where(eq(workOrderTasks.id, TASK));

  const res = await startTask(TASK, "cmd-authz-1");

  assert.equal(res.ok, false, "must be refused at the action boundary");
  if (!res.ok) assert.match(res.error, /another station/);
  assert.equal((await taskRow()).status, "PENDING");
  assert.equal((await balance()).onHand, 3, "nothing consumed");
});

test("authorization: a supervisor may start a step at any station", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });
  await collect();
  await db
    .update(workOrderTasks)
    .set({ stationId: OTHER_STATION })
    .where(eq(workOrderTasks.id, TASK));

  sessionUser = { ...sessionUser!, role: "SUPERVISOR" };
  const res = await startTask(TASK, "cmd-sup-1");

  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.equal((await taskRow()).status, "IN_PROGRESS");
});

test("authorization: an unauthenticated caller is refused", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });
  sessionUser = null;

  const res = await startTask(TASK, "cmd-anon-1");

  assert.equal(res.ok, false, "no session, no action");
  assert.equal((await balance()).onHand, 3, "nothing consumed");
});

// ===========================================================================
// Dependencies are enforced on the SERVER, not merely greyed out in the UI
// ===========================================================================

test("a step whose predecessor is unfinished cannot be started, even by a direct call", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });

  // A second step after this one, and a dependency saying so. The UI would hide
  // the button; this test bypasses the UI entirely.
  const [later] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: (await taskRow()).workOrderId,
      sequence: 2,
      name: "Run test",
      stationId: sessionUser!.stationId,
      expectedMinutes: 20,
    })
    .returning();
  await db.insert(operationDependencies).values({
    operationId: later.id,
    dependsOnOperationId: TASK,
    type: "FULL_COMPLETION",
  });

  const res = await startTask(later.id, "cmd-dep-1");

  assert.equal(res.ok, false, "refused");
  assert.equal(res.ok === false && res.code, "DEPENDENCY");
  assert.match(
    res.ok === false ? res.error : "",
    /Fit motor/,
    "and the message names the step being waited on"
  );

  const [row] = await db.select().from(workOrderTasks).where(eq(workOrderTasks.id, later.id));
  assert.equal(row.status, "PENDING", "the step did not start");
  assert.equal((await balance()).onHand, 3, "and nothing was consumed");
});

test("the same step starts once its predecessor is done", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });

  const [later] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: (await taskRow()).workOrderId,
      sequence: 2,
      name: "Run test",
      stationId: sessionUser!.stationId,
      expectedMinutes: 20,
    })
    .returning();
  await db.insert(operationDependencies).values({
    operationId: later.id,
    dependsOnOperationId: TASK,
    type: "FULL_COMPLETION",
  });

  await db.update(workOrderTasks).set({ status: "DONE" }).where(eq(workOrderTasks.id, TASK));

  const res = await startTask(later.id, "cmd-dep-2");
  assert.equal(res.ok, true, res.ok ? "" : res.error);

  const [row] = await db.select().from(workOrderTasks).where(eq(workOrderTasks.id, later.id));
  assert.equal(row.status, "IN_PROGRESS");
});

// ===========================================================================
// A requirement met by a sub-assembly, not by stock
// ===========================================================================

test("a step starts when its component came from a sub-assembly rather than the racks", async () => {
  // Found by scripts/simulate.mjs: the dependency layer counted allocated
  // sub-assembly output as satisfying a requirement, and this action did not — so
  // the card said "ready", the worker tapped Start, and the server refused it for
  // lack of stock that was never going to exist.
  const { reportProduction, inspectOutput, allocateOutput } = await import(
    "../src/lib/outputs.ts"
  );

  const task = await taskRow();

  // A second requirement on the same step, for a part that is MADE, not bought.
  const [madePart] = await db
    .insert(items)
    .values({ sku: "SUB-MADE-01", name: "Made Here Part", procurementType: "MANUFACTURED" })
    .returning();
  const [madeReq] = await db
    .insert(materialRequirements)
    .values({ operationId: TASK, itemId: madePart.id, requiredQty: 1 })
    .returning();

  // Somewhere else builds it and earmarks it for this requirement. No stock is
  // ever received — an accepted sub-assembly is not a receipt into a location.
  const [source] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: task.workOrderId,
      sequence: 9,
      name: "Build the made part",
      stationId: sessionUser!.stationId,
    })
    .returning();
  await reportProduction({ commandId: uid("p"), operationId: source.id, quantity: 1 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: source.id,
    from: "pendingInspection",
    to: "accepted",
    quantity: 1,
  });
  await allocateOutput({
    commandId: uid("a"),
    operationId: source.id,
    requirementId: madeReq.id,
    quantity: 1,
  });

  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 3 });
  await collect();

  const res = await startTask(TASK, "cmd-subasm-1");

  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.equal((await taskRow()).status, "IN_PROGRESS");
  assert.equal((await balance()).onHand, 2, "the purchased motor was collected normally");

  const stockMoves = await db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.itemId, madePart.id));
  assert.equal(stockMoves.length, 0, "and nothing was committed from stock for the made part");
});
