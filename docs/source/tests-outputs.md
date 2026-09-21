# Source: tests/outputs.test.ts

Commit 32fe146. Reproduced as a document because the source archive has not been reaching the reviewer.

```ts
import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { resetDatabase, uid } from "./helpers";
import {
  items,
  stations,
  workOrders,
  workOrderTasks,
  routingSteps,
  inventoryLocations,
  inventoryBalances,
  materialRequirements,
  dispositionRecords,
} from "../src/db/schema";
import {
  coverageFor,
  receiveStock,
  reserveForRequirement,
  issueAgainstReservation,
  issueUnreserved,
  placeHold,
  releaseHold,
  availableNow,
  reconcile,
  CommandError,
} from "../src/lib/inventory";
import {
  reportProduction,
  inspectOutput,
  allocateOutput,
  issueOutputToParent,
  returnOutputFromParent,
  rejectInstalledOutput,
  outputStateFor,
  satisfiedQuantityFor,
} from "../src/lib/outputs";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

let PANEL = 0;
let STORES = 0;
let OP = 0;
let REQ_A = 0;
let REQ_B = 0;

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();


  const [panel] = await db
    .insert(items)
    .values({ sku: "SUB-PANEL-01", name: "Insulated Panel", procurementType: "MANUFACTURED" })
    .returning();
  PANEL = panel.id;

  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();
  STORES = stores.id;

  const [station] = await db.insert(stations).values({ name: "Panel Fab" }).returning();
  const [step] = await db
    .insert(routingSteps)
    .values({ itemId: PANEL, sequence: 1, name: "Close double-wall", stationId: station.id })
    .returning();

  const mk = async (orderNumber: string) => {
    const [wo] = await db
      .insert(workOrders)
      .values({ orderNumber, itemId: PANEL, quantity: 1, status: "RELEASED" })
      .returning();
    const [task] = await db
      .insert(workOrderTasks)
      .values({
        workOrderId: wo.id,
        routingStepId: step.id,
        sequence: 1,
        name: "Close double-wall",
        stationId: station.id,
      })
      .returning();
    const [req] = await db
      .insert(materialRequirements)
      .values({ operationId: task.id, itemId: PANEL, requiredQty: 4 })
      .returning();
    return { taskId: task.id, reqId: req.id };
  };

  const a = await mk("WO-A");
  const b = await mk("WO-B");
  OP = a.taskId;
  REQ_A = a.reqId;
  REQ_B = b.reqId;
});

const bal = async () => {
  const [row] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, PANEL), eq(inventoryBalances.locationId, STORES)));
  return row ?? { onHand: 0, activeReserved: 0, heldQty: 0 };
};

// ===========================================================================
// Rev 4 correction 1 — current availability must not come from monotonic counters
// ===========================================================================

test("A2 — replaying an identical production report applies once", async () => {
  const payload = { commandId: uid("prod"), operationId: OP, quantity: 3 };
  await reportProduction(payload);
  await reportProduction(payload);

  const s = await outputStateFor(OP);
  assert.equal(s.produced, 3, "reported once, not twice");
  assert.equal(s.pendingInspection, 3);

  const records = await db
    .select()
    .from(dispositionRecords)
    .where(eq(dispositionRecords.kind, "PRODUCED"));
  assert.equal(records.length, 1, "exactly one disposition record");
});

test("A3 — a legitimate second partial production report is additive", async () => {
  await reportProduction({ commandId: uid("prod"), operationId: OP, quantity: 3 });
  await reportProduction({ commandId: uid("prod"), operationId: OP, quantity: 2 });

  const s = await outputStateFor(OP);
  assert.equal(s.produced, 5, "3 then 2 both counted");
  assert.equal(s.pendingInspection, 5);
});

test("A4 — reusing a command id with a different quantity is rejected (production report)", async () => {
  const cmd = uid("prod");
  await reportProduction({ commandId: cmd, operationId: OP, quantity: 3 });

  await assert.rejects(
    () => reportProduction({ commandId: cmd, operationId: OP, quantity: 99 }),
    (e: unknown) => e instanceof CommandError && e.code === "COMMAND_ID_REUSED"
  );
  assert.equal((await outputStateFor(OP)).produced, 3, "unchanged");
});

test("A7b — new output is pendingInspection, neither usable nor scrap", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 4 });

  const s = await outputStateFor(OP);
  assert.equal(s.produced, 4);
  assert.equal(s.pendingInspection, 4, "awaiting judgement");
  assert.equal(s.accepted, 0);
  assert.equal(s.scrapped, 0, "must NOT be reported as scrap (the rev-1 defect)");
  assert.equal(s.usableOutput, 0, "nothing usable until inspected");
});

test("issue to parent then return restores usable output", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 1 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "pendingInspection",
    to: "accepted",
    quantity: 1,
  });
  assert.equal((await outputStateFor(OP)).usableOutput, 1, "accepted and free");

  await allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_A, quantity: 1 });
  await issueOutputToParent({
    commandId: uid("s"),
    operationId: OP,
    requirementId: REQ_A,
    quantity: 1,
  });
  assert.equal((await outputStateFor(OP)).usableOutput, 0, "installed in the parent");

  await returnOutputFromParent({
    commandId: uid("r"),
    operationId: OP,
    requirementId: REQ_A,
    quantity: 1,
  });

  const s = await outputStateFor(OP);
  assert.equal(s.usableOutput, 1, "a return restores availability (monotonic consumed said 0)");
  assert.equal(s.produced, 1, "no new unit invented");

  // History is intact: the install is still on the record.
  const installs = await db
    .select()
    .from(dispositionRecords)
    .where(eq(dispositionRecords.kind, "ISSUE_TO_PARENT"));
  assert.equal(installs.length, 1, "the original install remains in append-only history");
});

test("returned output can be reissued", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 1 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "pendingInspection",
    to: "accepted",
    quantity: 1,
  });
  await allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_A, quantity: 1 });
  await issueOutputToParent({ commandId: uid("s"), operationId: OP, requirementId: REQ_A, quantity: 1 });
  await returnOutputFromParent({ commandId: uid("r"), operationId: OP, requirementId: REQ_A, quantity: 1 });

  // Reissue to a different requirement — the unit is genuinely free again.
  await allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_B, quantity: 1 });
  await issueOutputToParent({ commandId: uid("s"), operationId: OP, requirementId: REQ_B, quantity: 1 });

  const s = await outputStateFor(OP);
  assert.equal(s.issuedToParentOutstanding, 1);
  assert.equal(s.produced, 1, "still one physical panel");
  assert.equal(s.usableOutput, 0);
});

test("accept, rework, then re-accept does not invent a second unit", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 1 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "pendingInspection",
    to: "accepted",
    quantity: 1,
  });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "accepted",
    to: "awaitingRework",
    quantity: 1,
    reason: "gasket seal",
  });

  let s = await outputStateFor(OP);
  assert.equal(s.accepted, 0);
  assert.equal(s.awaitingRework, 1);
  assert.equal(s.usableOutput, 0);

  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "awaitingRework",
    to: "accepted",
    quantity: 1,
  });

  s = await outputStateFor(OP);
  assert.equal(s.produced, 1, "one physical panel throughout (monotonic counter said 2)");
  assert.equal(s.accepted, 1);
  assert.equal(s.usableOutput, 1);
  assert.equal(
    s.pendingInspection + s.accepted + s.awaitingRework + s.scrapped,
    s.produced,
    "invariant 1 holds"
  );
});

test("A8c — rejecting an installed component keeps its installation history", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 4 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "pendingInspection",
    to: "accepted",
    quantity: 4,
  });
  await allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_A, quantity: 4 });
  await issueOutputToParent({ commandId: uid("s"), operationId: OP, requirementId: REQ_A, quantity: 4 });

  const before = await outputStateFor(OP);
  await rejectInstalledOutput({
    commandId: uid("rej"),
    operationId: OP,
    requirementId: REQ_A,
    quantity: 2,
    reason: "delamination found at final QC",
  });
  const after = await outputStateFor(OP);

  assert.equal(after.accepted, before.accepted, "child disposition untouched");
  assert.equal(
    after.issuedToParentOutstanding,
    before.issuedToParentOutstanding,
    "installation not unwound — it did happen"
  );
  assert.ok(
    after.allocatedOutstanding + after.issuedToParentOutstanding <= after.accepted,
    "invariant 3 still holds (rev-2 bound it to current accepted and broke here)"
  );

  const rejections = await db
    .select()
    .from(dispositionRecords)
    .where(eq(dispositionRecords.kind, "REJECT_INSTALLED"));
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].quantity, 2);
});

test("A13b — dependency stays satisfied after the allocation is consumed", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 4 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "pendingInspection",
    to: "accepted",
    quantity: 4,
  });
  await allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_A, quantity: 4 });

  assert.equal(await satisfiedQuantityFor(REQ_A), 4, "satisfied by allocation");

  await issueOutputToParent({ commandId: uid("s"), operationId: OP, requirementId: REQ_A, quantity: 4 });

  assert.equal(
    (await outputStateFor(OP)).allocatedOutstanding,
    0,
    "outstanding allocation relieved by the install"
  );
  assert.equal(
    await satisfiedQuantityFor(REQ_A),
    4,
    "still satisfied — reading only allocation would block the resume"
  );
});

test("A7 — allocation, not global accepted, decides who is ready", async () => {
  await reportProduction({ commandId: uid("p"), operationId: OP, quantity: 4 });
  await inspectOutput({
    commandId: uid("i"),
    operationId: OP,
    from: "pendingInspection",
    to: "accepted",
    quantity: 4,
  });
  await allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_A, quantity: 4 });

  assert.equal(await satisfiedQuantityFor(REQ_A), 4, "A has its four panels");
  assert.equal(await satisfiedQuantityFor(REQ_B), 0, "B has none, despite 4 being accepted");

  await assert.rejects(
    () =>
      allocateOutput({ commandId: uid("a"), operationId: OP, requirementId: REQ_B, quantity: 4 }),
    (e: unknown) => e instanceof CommandError,
    "B cannot claim the same four panels"
  );
});

// ===========================================================================
// Rev 4 correction 2 — held stock is not available
// ===========================================================================

test("A6e — held stock can be neither reserved nor issued", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: PANEL, locationId: STORES, quantity: 5 });
  assert.equal(await availableNow(PANEL, STORES), 5);

  const { holdId } = await placeHold({
    commandId: uid("h"),
    itemId: PANEL,
    locationId: STORES,
    quantity: 5,
    reason: "supplier certificate missing",
  });

  assert.equal(await availableNow(PANEL, STORES), 0, "5 on hold means 0 available");

  const { reserved } = await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: PANEL,
    locationId: STORES,
    quantity: 5,
  });
  assert.equal(reserved, 0, "held stock cannot be reserved");

  await assert.rejects(
    () =>
      issueUnreserved({
        commandId: uid("u"),
        requirementId: REQ_A,
        itemId: PANEL,
        locationId: STORES,
        quantity: 1,
      }),
    (e: unknown) => e instanceof CommandError,
    "held stock cannot be issued either"
  );

  assert.equal((await bal()).onHand, 5, "physically still there");
  void holdId;
});

test("A6f — releasing a hold restores availability exactly once", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: PANEL, locationId: STORES, quantity: 5 });
  const { holdId } = await placeHold({
    commandId: uid("h"),
    itemId: PANEL,
    locationId: STORES,
    quantity: 5,
    reason: "awaiting certificate",
  });
  assert.equal(await availableNow(PANEL, STORES), 0);

  await releaseHold({ commandId: uid("rel"), holdId });
  assert.equal(await availableNow(PANEL, STORES), 5, "restored");

  // Replay of the same command: no further effect.
  const replay = uid("rel2");
  await releaseHold({ commandId: replay, holdId }).catch(() => {});
  assert.equal(await availableNow(PANEL, STORES), 5, "still 5, not 10");

  // A brand-new command id must still fail the state guard (§6.2).
  await assert.rejects(
    () => releaseHold({ commandId: uid("rel3"), holdId }),
    (e: unknown) => e instanceof CommandError && e.code === "STATE_GUARD",
    "a fresh command id does not permit releasing an already-released hold"
  );
  assert.equal(await availableNow(PANEL, STORES), 5, "availability unchanged");
});

test("a reservation owner still cannot draw stock that is on hold", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: PANEL, locationId: STORES, quantity: 5 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: PANEL,
    locationId: STORES,
    quantity: 3,
  });
  // Hold 2 of the 2 unreserved units — A keeps its 3.
  await placeHold({
    commandId: uid("h"),
    itemId: PANEL,
    locationId: STORES,
    quantity: 2,
    reason: "spot check",
  });

  // 5 on hand, 3 reserved to A, 2 held -> only 3 usable, so issuing 4 must fail.
  await assert.rejects(
    () =>
      issueAgainstReservation({
        commandId: uid("i"),
        requirementId: REQ_A,
        itemId: PANEL,
        locationId: STORES,
        quantity: 4,
      }),
    (e: unknown) => e instanceof CommandError
  );

  // Its own 3 are fine.
  await issueAgainstReservation({
    commandId: uid("i"),
    requirementId: REQ_A,
    itemId: PANEL,
    locationId: STORES,
    quantity: 3,
  });
  const b = await bal();
  assert.equal(b.onHand, 2);
  assert.equal(b.heldQty, 2, "the held units are what remain");
});

test("A6g — a hold releases the reservations it invalidates", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: PANEL, locationId: STORES, quantity: 5 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: PANEL,
    locationId: STORES,
    quantity: 3,
  });
  assert.equal((await coverageFor(REQ_A)).uncovered, 1, "4 required, 3 reserved");

  // QC holds ALL five, including the three already reserved to A.
  const { holdId } = await placeHold({
    commandId: uid("h"),
    itemId: PANEL,
    locationId: STORES,
    quantity: 5,
    reason: "supplier certificate withdrawn",
  });

  const b = await bal();
  assert.equal(b.heldQty, 5, "quality does not defer to commitments");
  assert.equal(b.activeReserved, 0, "A's reservation was released by the hold");
  assert.equal(b.onHand, 5, "stock physically still there");
  assert.equal(await availableNow(PANEL, STORES), 0);

  assert.equal(
    (await coverageFor(REQ_A)).uncovered,
    4,
    "A's requirement is uncovered again, not silently still satisfied"
  );

  // The stale reservation must not authorise an issue.
  await assert.rejects(
    () =>
      issueAgainstReservation({
        commandId: uid("i"),
        requirementId: REQ_A,
        itemId: PANEL,
        locationId: STORES,
        quantity: 1,
      }),
    (e: unknown) => e instanceof CommandError,
    "a released reservation cannot authorise issuing held stock"
  );

  // Releasing the hold frees the stock but does NOT resurrect the reservation.
  await releaseHold({ commandId: uid("rel"), holdId });
  const after = await bal();
  assert.equal(after.heldQty, 0);
  assert.equal(after.activeReserved, 0, "must be re-reserved; priorities may have changed");
  assert.equal(await availableNow(PANEL, STORES), 5);

  assert.deepEqual(await reconcile(), [], "balances still agree with their histories");
});

test("reconciliation checks stock, reservations and holds against their own histories", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: PANEL, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: PANEL,
    locationId: STORES,
    quantity: 4,
  });
  await placeHold({
    commandId: uid("h"),
    itemId: PANEL,
    locationId: STORES,
    quantity: 2,
    reason: "spot check",
  });
  await issueAgainstReservation({
    commandId: uid("i"),
    requirementId: REQ_A,
    itemId: PANEL,
    locationId: STORES,
    quantity: 1,
  });

  assert.deepEqual(await reconcile(), [], "all three fields agree with their histories");

  // The database refuses a state that violates invariant 5 outright.
  await assert.rejects(
    () =>
      db
        .update(inventoryBalances)
        .set({ onHand: 1, activeReserved: 99 })
        .where(eq(inventoryBalances.itemId, PANEL)),
    "CHECK constraint blocks activeReserved + heldQty > onHand"
  );

  // Now drift both fields to values the constraint permits, so reconcile must catch them.
  // State here: onHand 9, activeReserved 3, heldQty 2.
  await db
    .update(inventoryBalances)
    .set({ onHand: 8, activeReserved: 5 })
    .where(eq(inventoryBalances.itemId, PANEL));

  const drift = await reconcile();
  const fields = drift.map((d) => d.field).sort();
  assert.deepEqual(
    fields,
    ["activeReserved", "onHand"],
    "reservations reconcile against reservation records, not stock movements"
  );
  const reservedDrift = drift.find((d) => d.field === "activeReserved")!;
  assert.equal(reservedDrift.balance, 5);
  assert.equal(reservedDrift.history, 3, "reservation records still say 3");
});
```
