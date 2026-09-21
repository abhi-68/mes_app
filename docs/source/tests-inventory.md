# Source: tests/inventory.test.ts

Commit 32fe146. Reproduced as a document because the source archive has not been reaching the reviewer.

```ts
import "dotenv/config";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
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
  inventoryMovements,
  materialRequirements,
  reservations,
} from "../src/db/schema";
import {
  receiveStock,
  reserveForRequirement,
  issueAgainstReservation,
  issueUnreserved,
  returnMaterial,
  coverageFor,
  availableNow,
  reconcile,
  CommandError,
} from "../src/lib/inventory";

// Guard: these tests truncate every table, so refuse to run against anything
// that is not clearly the test database.
if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error(
    "Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`."
  );
}

let MOTOR = 0;
let STORES = 0;
let REQ_A = 0;
let REQ_B = 0;

before(async () => {
  await pool.query("select 1");
});

after(async () => {
  await pool.end();
});

/** Fresh fixture per test: one item, one location, two competing requirements. */
beforeEach(async () => {
  await resetDatabase();


  const [motor] = await db
    .insert(items)
    .values({ sku: "BUY-MOTOR-5HP", name: "Motor, 5 HP TEFC", procurementType: "PURCHASED" })
    .returning();
  MOTOR = motor.id;

  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();
  STORES = stores.id;

  const [station] = await db.insert(stations).values({ name: "Fan & Motor Assembly" }).returning();

  const [step] = await db
    .insert(routingSteps)
    .values({ itemId: MOTOR, sequence: 1, name: "Fit motor", stationId: station.id })
    .returning();

  const mk = async (orderNumber: string) => {
    const [wo] = await db
      .insert(workOrders)
      .values({ orderNumber, itemId: MOTOR, quantity: 1, status: "RELEASED" })
      .returning();
    const [task] = await db
      .insert(workOrderTasks)
      .values({
        workOrderId: wo.id,
        routingStepId: step.id,
        sequence: 1,
        name: "Fit motor",
        stationId: station.id,
      })
      .returning();
    const [req] = await db
      .insert(materialRequirements)
      .values({ operationId: task.id, itemId: MOTOR, requiredQty: 10 })
      .returning();
    return req.id;
  };

  REQ_A = await mk("WO-A");
  REQ_B = await mk("WO-B");
});

const balance = async () => {
  const [row] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, MOTOR), eq(inventoryBalances.locationId, STORES)));
  return row ?? { onHand: 0, activeReserved: 0 };
};

// ===========================================================================

// NOT a concurrency test: these two calls serialise, and this passes even with every
// row lock removed. Real concurrency is proven in tests/concurrency.test.ts (A1).
test("sequential competition for the last motor leaves exactly one commitment", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 1 });

  const [a, b] = await Promise.allSettled([
    reserveForRequirement({
      commandId: uid("resA"),
      requirementId: REQ_A,
      itemId: MOTOR,
      locationId: STORES,
      quantity: 1,
    }),
    reserveForRequirement({
      commandId: uid("resB"),
      requirementId: REQ_B,
      itemId: MOTOR,
      locationId: STORES,
      quantity: 1,
    }),
  ]);

  const got = [a, b].map((r) => (r.status === "fulfilled" ? r.value.reserved : 0));
  assert.equal(got.filter((n) => n === 1).length, 1, "exactly one reservation of 1 should succeed");
  assert.equal(got.filter((n) => n === 0).length, 1, "the other gets nothing");

  const bal = await balance();
  assert.equal(bal.onHand, 1, "on hand unchanged by reserving");
  assert.equal(bal.activeReserved, 1);
  assert.equal(await availableNow(MOTOR, STORES), 0, "available now is 0");

  const loser = got[0] === 0 ? REQ_A : REQ_B;
  const cov = await coverageFor(loser);
  assert.equal(cov.uncovered, 10, "loser reports its full requirement uncovered");
});

test("A2i — replaying an identical material issue applies once", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });

  const cmd = uid("issue");
  const payload = {
    commandId: cmd,
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 3,
  };
  await issueAgainstReservation(payload);
  await issueAgainstReservation(payload);

  const bal = await balance();
  assert.equal(bal.onHand, 7, "3 issued once, not twice");
  const moves = await db.select().from(inventoryMovements).where(eq(inventoryMovements.type, "ISSUE"));
  assert.equal(moves.length, 1, "exactly one movement row");
});

test("A3i — a legitimate second partial material issue is additive", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });

  await issueAgainstReservation(
    { commandId: uid("i"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 3 }
  );
  await issueAgainstReservation(
    { commandId: uid("i"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 2 }
  );

  const bal = await balance();
  assert.equal(bal.onHand, 5, "3 then 2 both applied");
  const cov = await coverageFor(REQ_A);
  assert.equal(cov.netIssued, 5);
});

test("A4 — reusing a command id with a different payload is rejected (material issue)", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });

  const cmd = uid("issue");
  await issueAgainstReservation(
    { commandId: cmd, requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 3 }
  );

  await assert.rejects(
    () =>
      issueAgainstReservation(
        { commandId: cmd, requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 99 }
      ),
    (e: unknown) => e instanceof CommandError && e.code === "COMMAND_ID_REUSED"
  );

  const bal = await balance();
  assert.equal(bal.onHand, 7, "quantity unchanged by the rejected command");
});

test("A5 — a failed command leaves nothing partially applied", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 5 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 5,
  });

  const before = await balance();
  const beforeMoves = (await db.select().from(inventoryMovements)).length;

  // 5 reserved but asking for 9 — must fail after the balance row is already locked.
  await assert.rejects(() =>
    issueAgainstReservation(
      { commandId: uid("bad"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 9 }
    )
  );

  const after = await balance();
  assert.equal(after.onHand, before.onHand, "on hand rolled back");
  assert.equal(after.activeReserved, before.activeReserved, "reservation rolled back");
  assert.equal(
    (await db.select().from(inventoryMovements)).length,
    beforeMoves,
    "no movement written"
  );
  const req = await coverageFor(REQ_A);
  assert.equal(req.netIssued, 0, "requirement not advanced");
});

test("A6 — stock cannot go negative", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 1 });

  await assert.rejects(
    () =>
      issueUnreserved(
        { commandId: uid("u"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 3 }
      ),
    (e: unknown) => e instanceof CommandError && e.code === "INSUFFICIENT_STOCK"
  );

  const bal = await balance();
  assert.equal(bal.onHand, 1, "on hand untouched");
  assert.ok(bal.onHand >= 0, "invariant 4 holds");
});

test("A6b — an unreserved issue cannot take another order's reserved stock", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 5 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 5,
  });

  await assert.rejects(
    () =>
      issueUnreserved(
        { commandId: uid("u"), requirementId: REQ_B, itemId: MOTOR, locationId: STORES, quantity: 1 }
      ),
    (e: unknown) => e instanceof CommandError && e.code === "INSUFFICIENT_STOCK",
    "raw on-hand is 5 but all of it belongs to A"
  );

  assert.equal((await balance()).onHand, 5);
});

test("A6c — coverage is zero after the reservation is fully issued", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });
  await issueAgainstReservation(
    { commandId: uid("i"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 10 }
  );

  const cov = await coverageFor(REQ_A);
  assert.equal(cov.activeReserved, 0, "reservation relieved by the issue");
  assert.equal(cov.netIssued, 10);
  assert.equal(cov.uncovered, 0, "must NOT report 10 missing (the rev-1 defect)");
});

test("A6d — the reservation's owner can issue it; another order cannot", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });

  // The owner draws its own stock — the guard must not be onHand - activeReserved.
  await issueAgainstReservation(
    { commandId: uid("i"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 10 }
  );

  const bal = await balance();
  assert.equal(bal.onHand, 0);
  assert.equal(bal.activeReserved, 0);

  const [resv] = await db
    .select()
    .from(reservations)
    .where(eq(reservations.requirementId, REQ_A));
  assert.equal(resv.outstandingQty, 0, "reservation drawn down");

  // And order B may not draw against a reservation it does not own.
  await receiveStock({ commandId: uid("rcv2"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("resA2"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });
  await assert.rejects(
    () =>
      issueAgainstReservation(
        { commandId: uid("iB"), requirementId: REQ_B, itemId: MOTOR, locationId: STORES, quantity: 1 }
      ),
    (e: unknown) => e instanceof CommandError && e.code === "NOT_RESERVED_TO_YOU"
  );
});

test("returns raise the uncovered quantity again", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 10,
  });
  await issueAgainstReservation(
    { commandId: uid("i"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 10 }
  );
  await returnMaterial(
    { commandId: uid("r"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 2 }
  );

  const cov = await coverageFor(REQ_A);
  assert.equal(cov.netIssued, 8);
  assert.equal(cov.uncovered, 2, "2 came back, so 2 are needed again");
  assert.equal((await balance()).onHand, 2, "returned stock is back on the shelf");
});

test("ledger and balances reconcile after a full cycle", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 10 });
  await reserveForRequirement({
    commandId: uid("res"),
    requirementId: REQ_A,
    itemId: MOTOR,
    locationId: STORES,
    quantity: 6,
  });
  await issueAgainstReservation(
    { commandId: uid("i"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 4 }
  );
  await returnMaterial(
    { commandId: uid("r"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 1 }
  );

  const drift = await reconcile();
  assert.deepEqual(drift, [], "balances must equal the sum of movement history");
});

test("partial reservation records a shortage rather than failing", async () => {
  await receiveStock({ commandId: uid("rcv"), itemId: MOTOR, locationId: STORES, quantity: 6 });
  const { reserved } = await reserveForRequirement(
    { commandId: uid("res"), requirementId: REQ_A, itemId: MOTOR, locationId: STORES, quantity: 10 }
  );

  assert.equal(reserved, 6, "reserve what exists");
  const cov = await coverageFor(REQ_A);
  assert.equal(cov.uncovered, 4, "4 uncovered — a normal state, not an error");
});
```
