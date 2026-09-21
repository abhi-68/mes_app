import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { db, pool } from "../src/db";
import * as schema from "../src/db/schema";
import {
  items,
  stations,
  workOrders,
  workOrderTasks,
  routingSteps,
  inventoryLocations,
  inventoryBalances,
  materialRequirements,
  reservations,
} from "../src/db/schema";
import { reserveForRequirement, coverageFor, availableNow } from "../src/lib/inventory";
import { resetDatabase, uid } from "./helpers";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

let MOTOR = 0;
let STORES = 0;
let REQ_A = 0;
let REQ_B = 0;

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();

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

  const [station] = await db.insert(stations).values({ name: "Fan Assembly" }).returning();
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
      .values({ operationId: task.id, itemId: MOTOR, requiredQty: 1 })
      .returning();
    return req.id;
  };

  REQ_A = await mk("WO-A");
  REQ_B = await mk("WO-B");

  // One motor, unreserved.
  await db.insert(inventoryBalances).values({
    itemId: MOTOR,
    locationId: STORES,
    onHand: 1,
    activeReserved: 0,
  });
});

/** A drizzle handle bound to one dedicated connection, so transactions are real. */
async function dedicated() {
  const client: PoolClient = await pool.connect();
  return { client, tx: drizzle(client, { schema }) };
}

/** The engine's Exec.tx expects a transaction handle; a dedicated connection inside an
 *  explicit BEGIN behaves identically for our purposes. */
type ExecTx = Parameters<typeof reserveForRequirement>[1] extends infer E
  ? E extends { tx?: infer T }
    ? T
    : never
  : never;

const settled = (p: Promise<unknown>) => {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  return () => done;
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================

test("A1 — competing reservations genuinely overlap; the second blocks on the lock", async () => {
  const a = await dedicated();
  const b = await dedicated();

  try {
    // Two real, simultaneously open transactions on separate connections.
    await a.client.query("BEGIN");
    await b.client.query("BEGIN");

    // A reserves the only motor, and does NOT commit yet.
    const resA = await reserveForRequirement(
      {
        commandId: uid("resA"),
        requirementId: REQ_A,
        itemId: MOTOR,
        locationId: STORES,
        quantity: 1,
      },
      { tx: a.tx as unknown as ExecTx }
    );
    assert.equal(resA.reserved, 1, "A takes the motor");

    // B now attempts the same row while A still holds the lock.
    const pendingB = reserveForRequirement(
      {
        commandId: uid("resB"),
        requirementId: REQ_B,
        itemId: MOTOR,
        locationId: STORES,
        quantity: 1,
      },
      { tx: b.tx as unknown as ExecTx }
    );
    const bDone = settled(pendingB);

    // THE POINT OF THIS TEST: B must be blocked. Without SELECT ... FOR UPDATE it
    // would sail past, read the pre-update balance, and over-commit the same motor.
    await tick(400);
    assert.equal(
      bDone(),
      false,
      "B must block on A's row lock — if it resolves here there is no locking"
    );

    await a.client.query("COMMIT");

    const resB = await pendingB;
    await b.client.query("COMMIT");

    assert.equal(resB.reserved, 0, "B sees the committed state and gets nothing");
  } finally {
    await a.client.query("ROLLBACK").catch(() => {});
    await b.client.query("ROLLBACK").catch(() => {});
    a.client.release();
    b.client.release();
  }

  // Exactly one commitment exists, and the summary agrees with it.
  const [balance] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, MOTOR), eq(inventoryBalances.locationId, STORES)));
  assert.equal(balance.onHand, 1, "reserving moves no stock");
  assert.equal(balance.activeReserved, 1, "exactly one motor is committed");
  assert.equal(await availableNow(MOTOR, STORES), 0);

  const rows = await db.select().from(reservations);
  const totalOutstanding = rows.reduce((s, r) => s + r.outstandingQty, 0);
  assert.equal(
    totalOutstanding,
    balance.activeReserved,
    "no over-commitment: reservation records equal the balance"
  );

  assert.equal((await coverageFor(REQ_B)).uncovered, 1, "B still needs its motor");
});

test("many simultaneous reservations for one unit yield exactly one winner", async () => {
  const attempts = 12;
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, (_, i) =>
      reserveForRequirement({
        commandId: uid(`race${i}`),
        requirementId: i % 2 === 0 ? REQ_A : REQ_B,
        itemId: MOTOR,
        locationId: STORES,
        quantity: 1,
      })
    )
  );

  const won = results.filter(
    (r) => r.status === "fulfilled" && r.value.reserved === 1
  ).length;
  assert.equal(won, 1, `exactly one of ${attempts} attempts may take the single motor`);

  const [balance] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, MOTOR), eq(inventoryBalances.locationId, STORES)));
  const rows = await db.select().from(reservations);
  const totalOutstanding = rows.reduce((s, r) => s + r.outstandingQty, 0);

  assert.equal(balance.activeReserved, 1);
  assert.equal(totalOutstanding, 1, "no double-commitment under contention");
});
