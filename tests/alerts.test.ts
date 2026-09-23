import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import { db, pool } from "../src/db";
import { resetDatabase, uid } from "./helpers";
import {
  items,
  users,
  stations,
  workOrders,
  workOrderTasks,
  routingSteps,
  bomLines,
  inventoryLocations,
  materialRequirements,
  timeEntries,
  alerts,
} from "../src/db/schema";
import { releaseWorkOrder } from "../src/lib/work-orders";
import { deliverCompletedSubAssembly } from "../src/lib/outputs";
import { blockersFor } from "../src/lib/dependencies";
import {
  raiseAlert,
  announceNewlyReady,
  acknowledgeReadyAlerts,
  alertsFor,
  LATE_MULTIPLIER,
} from "../src/lib/alerts";
import { receiveStock } from "../src/lib/inventory";
import type { SessionUser } from "../src/lib/session";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

/** Same convergent shape as the dependency tests: a fan section feeding an AHU. */
let FAN = 0;
let MOTOR = 0;
let STORES = 0;
let finalStationId = 0;

let frameOp = 0;
let fitFanOp = 0;
let fanOp = 0;

let supervisor: SessionUser;
let finalAssemblyWorker: SessionUser;
let fanWorker: SessionUser;

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();

  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();
  STORES = stores.id;

  const [ahu, fan, motor] = await db
    .insert(items)
    .values([
      {
        sku: "CF-3000-H",
        name: "Air Handler CF-3000",
        procurementType: "MANUFACTURED" as const,
        isFinishedGood: true,
      },
      { sku: "SUB-FAN-01", name: "Fan Section", procurementType: "MANUFACTURED" as const },
      { sku: "BUY-MOTOR-5HP", name: "5HP Motor", procurementType: "PURCHASED" as const },
    ])
    .returning();
  FAN = fan.id;
  MOTOR = motor.id;

  const [frameStation, fanStation, finalStation] = await db
    .insert(stations)
    .values([{ name: "Frame Fab" }, { name: "Fan & Motor Assembly" }, { name: "Final Assembly" }])
    .returning();
  finalStationId = finalStation.id;

  const [sup, wFinal, wFan] = await db
    .insert(users)
    .values([
      {
        name: "Sam Supervisor",
        email: "sup@thermal-corp.com",
        passwordHash: "x",
        role: "SUPERVISOR" as const,
        stationId: finalStation.id,
      },
      {
        name: "Ravi Kumar",
        email: "final@thermal-corp.com",
        passwordHash: "x",
        role: "WORKER" as const,
        stationId: finalStation.id,
      },
      {
        name: "Marcus Webb",
        email: "fan@thermal-corp.com",
        passwordHash: "x",
        role: "WORKER" as const,
        stationId: fanStation.id,
      },
    ])
    .returning();
  const asSession = (u: typeof sup): SessionUser => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    stationId: u.stationId,
  });
  supervisor = asSession(sup);
  finalAssemblyWorker = asSession(wFinal);
  fanWorker = asSession(wFan);

  const [s1, s2] = await db
    .insert(routingSteps)
    .values([
      { itemId: ahu.id, sequence: 1, name: "Build frame", stationId: frameStation.id, expectedMinutes: 90 },
      { itemId: ahu.id, sequence: 2, name: "Fit fan section", stationId: finalStation.id, expectedMinutes: 60 },
    ])
    .returning();

  const [fs1] = await db
    .insert(routingSteps)
    .values([
      { itemId: FAN, sequence: 1, name: "Assemble fan", stationId: fanStation.id, expectedMinutes: 45 },
    ])
    .returning();

  await db.insert(bomLines).values([
    { parentItemId: ahu.id, componentItemId: FAN, quantity: 1, consumedAtRoutingStepId: s2.id },
    { parentItemId: FAN, componentItemId: MOTOR, quantity: 1, consumedAtRoutingStepId: fs1.id },
  ]);

  const [order] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-1000", itemId: ahu.id, quantity: 1, status: "PLANNED" })
    .returning();
  await releaseWorkOrder(order.id, null);

  const parentTasks = await db
    .select()
    .from(workOrderTasks)
    .where(eq(workOrderTasks.workOrderId, order.id));
  frameOp = parentTasks.find((t) => t.routingStepId === s1.id)!.id;
  fitFanOp = parentTasks.find((t) => t.routingStepId === s2.id)!.id;

  const [child] = await db
    .select()
    .from(workOrders)
    .where(eq(workOrders.parentWorkOrderId, order.id));
  const [childTask] = await db
    .select()
    .from(workOrderTasks)
    .where(eq(workOrderTasks.workOrderId, child.id));
  fanOp = childTask.id;
});

const markDone = (taskId: number) =>
  db.update(workOrderTasks).set({ status: "DONE" }).where(eq(workOrderTasks.id, taskId));

// ===========================================================================
// The delivery that makes a convergent chain finish at all
// ===========================================================================

test("N1 — finishing a sub-assembly hands it to the parent and clears the wait", async () => {
  await markDone(frameOp);

  // Before: final assembly is short the fan section.
  const before = await blockersFor(fitFanOp);
  assert.ok(
    before.some((b) => b.label === "Sub-assembly"),
    "waiting on the fan section"
  );

  await deliverCompletedSubAssembly({ operationId: fanOp });

  const after = await blockersFor(fitFanOp);
  assert.equal(after.length, 0, "nothing left in the way once the section is handed over");
});

test("N2 — handing over twice does not deliver twice", async () => {
  await markDone(frameOp);
  await deliverCompletedSubAssembly({ operationId: fanOp });
  await deliverCompletedSubAssembly({ operationId: fanOp });

  const [req] = await db
    .select()
    .from(materialRequirements)
    .where(
      and(eq(materialRequirements.operationId, fitFanOp), eq(materialRequirements.itemId, FAN))
    );
  const { satisfiedQuantityFor } = await import("../src/lib/outputs");
  assert.equal(
    await satisfiedQuantityFor(req.id),
    1,
    "one fan section required, one delivered — not two"
  );
});

// ===========================================================================
// The alert the whole thing exists for
// ===========================================================================

test("N3 — the waiting station is told the moment its part arrives", async () => {
  await markDone(frameOp);
  await deliverCompletedSubAssembly({ operationId: fanOp });
  await announceNewlyReady(fanOp);

  const raised = await db.select().from(alerts).where(eq(alerts.kind, "STEP_READY"));
  assert.equal(raised.length, 1, "exactly one alert");
  assert.equal(
    raised[0].audienceStationId,
    finalStationId,
    "addressed to the station that was waiting, not broadcast"
  );
  assert.match(raised[0].title, /Fit fan section/);

  const forWorker = await alertsFor(finalAssemblyWorker);
  assert.ok(
    forWorker.some((a) => a.kind === "STEP_READY"),
    "the final assembly worker sees it"
  );

  const forOtherStation = await alertsFor(fanWorker);
  assert.equal(
    forOtherStation.some((a) => a.kind === "STEP_READY"),
    false,
    "a worker at another station is not bothered with it"
  );
});

test("N4 — no announcement while the step is still waiting on something else", async () => {
  // The frame is NOT done, so fitting the fan section cannot start even once the
  // fan section is delivered. Announcing it would send someone to a dead end.
  await deliverCompletedSubAssembly({ operationId: fanOp });
  await announceNewlyReady(fanOp);

  const raised = await db.select().from(alerts).where(eq(alerts.kind, "STEP_READY"));
  assert.equal(raised.length, 0, "still blocked by the frame, so nobody is told");
});

test("N5 — announcing twice leaves one alert, and starting the step clears it", async () => {
  await markDone(frameOp);
  await deliverCompletedSubAssembly({ operationId: fanOp });
  await announceNewlyReady(fanOp);
  await announceNewlyReady(fanOp);

  const open = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.kind, "STEP_READY"), eq(alerts.workOrderTaskId, fitFanOp)));
  assert.equal(open.length, 1, "not one per announcement");

  await acknowledgeReadyAlerts(fitFanOp, finalAssemblyWorker.id);
  const remaining = await alertsFor(finalAssemblyWorker);
  assert.equal(
    remaining.some((a) => a.kind === "STEP_READY"),
    false,
    "acting on it takes it off the list"
  );
});

// ===========================================================================
// Blocked goes to supervision, not to the floor
// ===========================================================================

test("N6 — a blocked step reaches supervisors and not other workers", async () => {
  await raiseAlert({
    kind: "STEP_BLOCKED",
    workOrderTaskId: fanOp,
    audienceStationId: null,
    title: "Blocked: Assemble fan",
    detail: "Waiting on vendor — motor delivery short",
    createdByUserId: fanWorker.id,
  });

  const forSupervisor = await alertsFor(supervisor);
  assert.ok(
    forSupervisor.some((a) => a.kind === "STEP_BLOCKED"),
    "the supervisor is told"
  );

  const forWorker = await alertsFor(finalAssemblyWorker);
  assert.equal(
    forWorker.some((a) => a.kind === "STEP_BLOCKED"),
    false,
    "an unrelated worker is not"
  );
});

test("N7 — raising the same block twice does not double up", async () => {
  const payload = {
    kind: "STEP_BLOCKED" as const,
    workOrderTaskId: fanOp,
    title: "Blocked: Assemble fan",
    detail: "Waiting on vendor",
  };
  await raiseAlert(payload);
  await raiseAlert(payload);

  const rows = await db.select().from(alerts).where(eq(alerts.kind, "STEP_BLOCKED"));
  assert.equal(rows.length, 1);
});

// ===========================================================================
// Conditions are derived, so they clear themselves
// ===========================================================================

test("N8 — a material shortage is reported to supervisors and vanishes when stock arrives", async () => {
  const short = await alertsFor(supervisor);
  const shortage = short.find((a) => a.kind === "MATERIAL_SHORT");
  assert.ok(shortage, "the fan step cannot be covered");
  assert.match(shortage.title, /5HP Motor/);
  assert.equal(shortage.acknowledgeable, false, "there is no row to dismiss");

  await receiveStock({ commandId: uid("recv"), itemId: MOTOR, locationId: STORES, quantity: 2 });

  const after = await alertsFor(supervisor);
  assert.equal(
    after.some((a) => a.kind === "MATERIAL_SHORT"),
    false,
    "fixing the cause removes the alert with no one clearing it"
  );
});

test("N9 — a step past its estimate is reported, and stops being late when the clock stops", async () => {
  // 45 minutes estimated; started three hours ago.
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const [entry] = await db
    .insert(timeEntries)
    .values({ workOrderTaskId: fanOp, userId: fanWorker.id, startedAt: threeHoursAgo })
    .returning();

  const late = (await alertsFor(supervisor)).find((a) => a.kind === "RUNNING_LATE");
  assert.ok(late, `45m estimate exceeded by more than ${LATE_MULTIPLIER}x`);
  assert.match(late.detail ?? "", /45m estimated/);

  await db
    .update(timeEntries)
    .set({ endedAt: new Date(), durationSeconds: 3 * 60 * 60 })
    .where(eq(timeEntries.id, entry.id));

  const after = await alertsFor(supervisor);
  assert.equal(
    after.some((a) => a.kind === "RUNNING_LATE"),
    false,
    "a finished step is not still running long"
  );
});

test("N10 — a step within its estimate raises nothing", async () => {
  await db
    .insert(timeEntries)
    .values({
      workOrderTaskId: fanOp,
      userId: fanWorker.id,
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

  const alertsNow = await alertsFor(supervisor);
  assert.equal(
    alertsNow.some((a) => a.kind === "RUNNING_LATE"),
    false,
    "20 minutes against a 45 minute estimate is not late"
  );
});

test("N11 — workers are not shown shortages they cannot act on", async () => {
  const forWorker = await alertsFor(fanWorker);
  assert.equal(
    forWorker.some((a) => a.kind === "MATERIAL_SHORT"),
    false,
    "buying is not their job; the shortage shows on their own step instead"
  );
});

// ===========================================================================
// Reorder point — a threshold, not a shortage
// ===========================================================================

test("N12 — an item at its reorder point tells managers to buy more", async () => {
  await db.update(items).set({ reorderPoint: 5 }).where(eq(items.id, MOTOR));
  await receiveStock({ commandId: uid("recv"), itemId: MOTOR, locationId: STORES, quantity: 4 });

  const reorder = (await alertsFor(supervisor)).find((a) => a.kind === "BELOW_REORDER");
  assert.ok(reorder, "4 free against a reorder point of 5");
  assert.match(reorder.title, /5HP Motor/);
  assert.equal(reorder.acknowledgeable, false, "a threshold clears when stock arrives");

  assert.equal(
    (await alertsFor(fanWorker)).some((a) => a.kind === "BELOW_REORDER"),
    false,
    "not a worker's problem"
  );
});

test("N13 — stocking above the point clears it, and an unset point never fires", async () => {
  await db.update(items).set({ reorderPoint: 5 }).where(eq(items.id, MOTOR));
  await receiveStock({ commandId: uid("recv"), itemId: MOTOR, locationId: STORES, quantity: 20 });

  assert.equal(
    (await alertsFor(supervisor)).some((a) => a.kind === "BELOW_REORDER"),
    false,
    "20 free against a point of 5"
  );

  // FAN has no reorder point set and no stock at all — which is not the same as
  // being below a threshold of zero.
  assert.equal(
    (await alertsFor(supervisor)).some(
      (a) => a.kind === "BELOW_REORDER" && /Fan Section/.test(a.title)
    ),
    false,
    "an item with no reorder point set is never chased"
  );
});

test("N14 — reserved stock does not count as free against the threshold", async () => {
  await db.update(items).set({ reorderPoint: 5 }).where(eq(items.id, MOTOR));
  await receiveStock({ commandId: uid("recv"), itemId: MOTOR, locationId: STORES, quantity: 6 });

  assert.equal(
    (await alertsFor(supervisor)).some((a) => a.kind === "BELOW_REORDER"),
    false,
    "6 free, above the point"
  );

  // Reserve most of it against the fan step's own requirement.
  const [req] = await db
    .select()
    .from(materialRequirements)
    .where(
      and(eq(materialRequirements.operationId, fanOp), eq(materialRequirements.itemId, MOTOR))
    );
  const { reserveForRequirement } = await import("../src/lib/inventory");
  await reserveForRequirement({
    commandId: uid("resv"),
    requirementId: req.id,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 2,
  });

  const reorder = (await alertsFor(supervisor)).find((a) => a.kind === "BELOW_REORDER");
  assert.ok(reorder, "4 free once 2 are promised elsewhere");
  assert.match(reorder.detail ?? "", /4 ea free/);
});

test("N15 — the threshold is the whole item, not one batch or one shelf", async () => {
  await db.update(items).set({ reorderPoint: 5 }).where(eq(items.id, MOTOR));

  const [bay] = await db
    .insert(inventoryLocations)
    .values({ code: "BAY-02", name: "Goods in bay 2" })
    .returning();

  // Four separate deliveries, none of which on its own clears a point of 5.
  for (const [i, locationId] of [STORES, STORES, bay.id, bay.id].entries()) {
    await receiveStock({
      commandId: uid(`recv${i}`),
      itemId: MOTOR,
      locationId,
      quantity: 3,
      lot: { batchNumber: `MTR-BATCH-${i}` },
    });
  }

  assert.equal(
    (await alertsFor(supervisor)).some((a) => a.kind === "BELOW_REORDER"),
    false,
    "12 in four batches across two locations is not a shortage, even though every batch is under 5"
  );
});
