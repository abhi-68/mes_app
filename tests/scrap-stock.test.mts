import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import {
  items, inventoryLocations, inventoryBalances, inventoryMovements, stockLots,
  workOrders, workOrderTasks, materialRequirements, stations,
} from "../src/db/schema.ts";
import { resetDatabase } from "./helpers.ts";
import {
  receiveStock, reserveForRequirement, placeHold, scrapStock, lotsFor, reconcile,
  coverageFor, CommandError,
} from "../src/lib/inventory.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

after(async () => {
  await pool.end();
});

/**
 * Writing damaged stock off.
 *
 * The interesting cases are all about what a write-off is allowed to walk over.
 * A dropped pallet is gone whoever had claimed it, so reservations give way; a
 * quality hold is somebody else's decision, so it does not.
 */

let ITEM = 0;
let LOC = 0;
let REQ = 0;
let LOT_A = 0;
let LOT_B = 0;

beforeEach(async () => {
  await resetDatabase();
  const [item] = await db.insert(items).values({
    sku: "RAW-GALV-16", name: "Galvanized Steel Sheet", procurementType: "PURCHASED",
  }).returning();
  ITEM = item.id;
  const [loc] = await db.insert(inventoryLocations).values({ code: "MAIN", name: "Stores" }).returning();
  LOC = loc.id;

  const [station] = await db.insert(stations).values({ name: "Sheet Metal" }).returning();
  const [order] = await db.insert(workOrders).values({
    orderNumber: "WO-1", itemId: ITEM, quantity: 1, status: "RELEASED",
  }).returning();
  const [task] = await db.insert(workOrderTasks).values({
    workOrderId: order.id, sequence: 1, name: "Cut skins", stationId: station.id,
  }).returning();
  const [req] = await db.insert(materialRequirements).values({
    operationId: task.id, itemId: ITEM, requiredQty: 40,
  }).returning();
  REQ = req.id;

  // Two batches, so "this pallet" means something.
  const a = await receiveStock({
    commandId: randomUUID(), itemId: ITEM, locationId: LOC, quantity: 30,
    lot: { batchNumber: "307290-1", heatNumber: "EB7728" },
  });
  const b = await receiveStock({
    commandId: randomUUID(), itemId: ITEM, locationId: LOC, quantity: 20,
    lot: { batchNumber: "307290-2", heatNumber: "EB9014" },
  });
  LOT_A = a.lotId!;
  LOT_B = b.lotId!;
});

const balance = async () =>
  (await db.select().from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, ITEM), eq(inventoryBalances.locationId, LOC))))[0];

const remainingOf = async (lotId: number) =>
  (await lotsFor(ITEM, LOC)).lots.find((l) => l.lotId === lotId)?.remaining ?? 0;

const scrap = (quantity: number, lotId: number | null, reason = "Water damage in the bay") =>
  scrapStock({ commandId: randomUUID(), itemId: ITEM, locationId: LOC, quantity, lotId, reason });

test("a damaged pallet leaves stock, and only that batch shrinks", async () => {
  assert.equal((await balance()).onHand, 50);

  const res = await scrap(10, LOT_A);
  assert.deepEqual(res, { scrapped: 10, reservationsReleased: 0 });

  assert.equal((await balance()).onHand, 40);
  assert.equal(await remainingOf(LOT_A), 20, "the scanned batch lost the units");
  assert.equal(await remainingOf(LOT_B), 20, "the other batch is untouched");
});

test("the write-off says who, which batch and why", async () => {
  await scrap(5, LOT_B, "Forklift through the stack");

  const [m] = await db.select().from(inventoryMovements)
    .where(eq(inventoryMovements.type, "SCRAP"));
  assert.equal(m.quantity, -5, "signed out of the location");
  assert.equal(m.lotId, LOT_B);
  assert.equal(m.lotAssumed, false, "it was scanned, not guessed");
  assert.equal(m.note, "Forklift through the stack");
});

test("a reason is not optional", async () => {
  await assert.rejects(() => scrap(1, LOT_A, "   "), /why it is being written off/);
  await assert.rejects(() => scrap(1, LOT_A, ""), /why it is being written off/);
  assert.equal((await balance()).onHand, 50, "nothing was written off");
});

test("you cannot write off more than the batch holds", async () => {
  await assert.rejects(() => scrap(31, LOT_A), (e: Error) => {
    assert.ok(e instanceof CommandError);
    assert.match(e.message, /only 30 left/i);
    return true;
  });
  assert.equal((await balance()).onHand, 50);
});

test("you cannot write off more than is on hand at all", async () => {
  await assert.rejects(() => scrap(51, null), /Only 50 on hand/);
  assert.equal((await balance()).onHand, 50);
});

test("quantity must be a real quantity", async () => {
  for (const bad of [0, -5]) {
    await assert.rejects(() => scrap(bad, LOT_A), /at least 1/);
  }
});

test("a dropped pallet gives way over a reservation, and the reservation is released", async () => {
  // 50 on hand, 45 committed to a job. A 10-unit write-off cannot leave 40 on hand
  // with 45 reserved against it.
  await reserveForRequirement({
    commandId: randomUUID(), requirementId: REQ, itemId: ITEM, locationId: LOC, quantity: 45,
  });
  assert.equal((await balance()).activeReserved, 45);

  const res = await scrap(10, LOT_A);
  assert.equal(res.scrapped, 10);
  assert.equal(res.reservationsReleased, 5, "just enough to make room, no more");

  const after = await balance();
  assert.equal(after.onHand, 40);
  assert.equal(after.activeReserved, 40, "the job keeps what still exists");
  assert.ok(after.activeReserved + after.heldQty <= after.onHand, "the invariant holds");

  // The shortage is now visible to planning rather than hidden.
  assert.equal((await coverageFor(REQ)).uncovered, 0);
});

test("a write-off that fits inside free stock disturbs no reservation", async () => {
  await reserveForRequirement({
    commandId: randomUUID(), requirementId: REQ, itemId: ITEM, locationId: LOC, quantity: 20,
  });
  const res = await scrap(10, LOT_A);
  assert.equal(res.reservationsReleased, 0);
  assert.equal((await balance()).activeReserved, 20, "untouched");
});

test("a quality hold is somebody else's decision and is NOT walked over", async () => {
  await placeHold({
    commandId: randomUUID(), itemId: ITEM, locationId: LOC, quantity: 45, reason: "Awaiting cert",
  });
  await assert.rejects(() => scrap(10, LOT_A), (e: Error) => {
    assert.match(e.message, /on quality hold/);
    assert.match(e.message, /Release the hold first/);
    return true;
  });
  assert.equal((await balance()).onHand, 50, "nothing moved");
});

test("replaying the same write-off applies once", async () => {
  const command = randomUUID();
  const once = { commandId: command, itemId: ITEM, locationId: LOC, quantity: 10, lotId: LOT_A, reason: "Bent" };
  await scrapStock(once);
  await scrapStock(once);

  assert.equal((await balance()).onHand, 40, "not 30");
  const rows = await db.select().from(inventoryMovements).where(eq(inventoryMovements.type, "SCRAP"));
  assert.equal(rows.length, 1, "one movement, not two");
});

test("two handlers writing off the last of a batch cannot both succeed", async () => {
  const both = await Promise.allSettled([scrap(30, LOT_A), scrap(30, LOT_A)]);
  const ok = both.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one write-off, not two");
  assert.equal(await remainingOf(LOT_A), 0);
  assert.equal((await balance()).onHand, 20);
});

test("the ledger still reconciles after a write-off", async () => {
  await scrap(10, LOT_A);
  await scrap(5, LOT_B, "Rust");
  assert.deepEqual(await reconcile(), [], "balances agree with their own movements");
});

test("stock with no batch behind it can still be written off", async () => {
  // Opening balances that predate lot tracking have no lot, and damage to them is
  // still real. The movement records a null lot rather than guessing at one.
  await db.insert(stockLots).values({ itemId: ITEM, batchNumber: "UNUSED" });
  const res = await scrap(4, null, "Miscount at stocktake");
  assert.equal(res.scrapped, 4);
  const [m] = await db.select().from(inventoryMovements)
    .where(eq(inventoryMovements.type, "SCRAP"));
  assert.equal(m.lotId, null);
});
