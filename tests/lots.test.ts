import "dotenv/config";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, asc } from "drizzle-orm";
import { db, pool } from "../src/db/index";
import {
  items,
  users,
  stations,
  vendors,
  workOrders,
  workOrderTasks,
  routingSteps,
  inventoryLocations,
  inventoryBalances,
  inventoryMovements,
  materialRequirements,
  stockLots,
} from "../src/db/schema";
import { resetDatabase, uid } from "./helpers";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

/*
 * Lot tracking.
 *
 * The design being tested: balances stay per item and location, and a lot's
 * remaining quantity is DERIVED by summing the signed movements that carry its id.
 * That makes two things worth proving. First, that the derivation actually agrees
 * with the balance — if it drifts, the whole point of not storing a second number
 * is lost. Second, that an issue spanning two lots writes one movement per lot,
 * because a single aggregated row is exactly what destroys the trace.
 */

let receiveStock: typeof import("../src/lib/inventory").receiveStock;
let issueAgainstReservation: typeof import("../src/lib/inventory").issueAgainstReservation;
let reserveForRequirement: typeof import("../src/lib/inventory").reserveForRequirement;
let returnMaterial: typeof import("../src/lib/inventory").returnMaterial;
let lotsFor: typeof import("../src/lib/inventory").lotsFor;
let lotByBatch: typeof import("../src/lib/inventory").lotByBatch;
let lotsConsumedBy: typeof import("../src/lib/inventory").lotsConsumedBy;
let CommandError: typeof import("../src/lib/inventory").CommandError;

before(async () => {
  ({
    receiveStock,
    issueAgainstReservation,
    reserveForRequirement,
    returnMaterial,
    lotsFor,
    lotByBatch,
    lotsConsumedBy,
    CommandError,
  } = await import("../src/lib/inventory"));
});

after(async () => {
  await pool.end();
});

let SHEET = 0;
let STORES = 0;
let TASK = 0;
let REQ = 0;
let ACTOR = 0;
let MILL = 0;

beforeEach(async () => {
  await resetDatabase();

  const [sheet] = await db
    .insert(items)
    .values({
      sku: "RAW-GALV-16",
      name: "Galvanized Steel Sheet, 16ga",
      procurementType: "PURCHASED",
      unitOfMeasure: "sheet",
    })
    .returning();
  SHEET = sheet.id;

  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();
  STORES = stores.id;

  const [mill] = await db
    .insert(vendors)
    .values({ name: "Kloeckner Metals Corp - HTX" })
    .returning();
  MILL = mill.id;

  const [station] = await db.insert(stations).values({ name: "Sheet Metal / Cutting" }).returning();
  const [user] = await db
    .insert(users)
    .values({
      name: "Priya Nair",
      email: "priya@thermal-corp.com",
      passwordHash: "x",
      role: "WORKER",
      stationId: station.id,
    })
    .returning();
  ACTOR = user.id;

  const [panel] = await db
    .insert(items)
    .values({ sku: "SUB-PANEL-01", name: "Insulated Panel Set", procurementType: "MANUFACTURED" })
    .returning();
  const [step] = await db
    .insert(routingSteps)
    .values({ itemId: panel.id, sequence: 1, name: "Cut & brake panel skins", stationId: station.id })
    .returning();
  const [wo] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-5000", itemId: panel.id, quantity: 1, status: "RELEASED" })
    .returning();
  const [task] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: wo.id,
      routingStepId: step.id,
      sequence: 1,
      name: "Cut & brake panel skins",
      stationId: station.id,
    })
    .returning();
  TASK = task.id;

  const [req] = await db
    .insert(materialRequirements)
    .values({ operationId: task.id, itemId: SHEET, requiredQty: 40 })
    .returning();
  REQ = req.id;
});

/** Receive a lot, with `at` controlling the order oldest-first will use. */
const receiveLot = async (
  quantity: number,
  heat: string,
  batch: string,
  minutesAgo: number
) =>
  receiveStock({
    commandId: uid("recv"),
    itemId: SHEET,
    locationId: STORES,
    quantity,
    actorUserId: ACTOR,
    lot: {
      heatNumber: heat,
      batchNumber: batch,
      vendorId: MILL,
      procurementReference: "PO-260750",
      storageLocation: "IN Bay 01",
      receivedAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });

const balance = async () => {
  const [row] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, SHEET), eq(inventoryBalances.locationId, STORES)));
  return row ?? { onHand: 0, activeReserved: 0, heldQty: 0 };
};

const issueMovements = async () =>
  db
    .select()
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.itemId, SHEET), eq(inventoryMovements.type, "ISSUE")))
    .orderBy(asc(inventoryMovements.id));

const issue = async (quantity: number) => {
  await reserveForRequirement({
    commandId: uid("resv"),
    requirementId: REQ,
    itemId: SHEET,
    locationId: STORES,
    quantity,
  });
  await issueAgainstReservation({
    commandId: uid("issue"),
    requirementId: REQ,
    itemId: SHEET,
    locationId: STORES,
    quantity,
    actorUserId: ACTOR,
  });
};

// ===========================================================================

test("L1 a receipt creates a lot and the receipt movement carries it", async () => {
  const { lotId } = await receiveLot(25, "EB7728", "307290-1", 60);
  assert.ok(lotId, "receiveStock should return the lot it created");

  const [lot] = await db.select().from(stockLots).where(eq(stockLots.id, lotId!));
  assert.equal(lot.heatNumber, "EB7728");
  assert.equal(lot.batchNumber, "307290-1");
  assert.equal(lot.vendorId, MILL);
  assert.equal(lot.storageLocation, "IN Bay 01");

  const [movement] = await db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.type, "RECEIPT"));
  assert.equal(movement.lotId, lotId);
});

test("L2 a receipt with no lot details is allowed and stays unlotted", async () => {
  // An opening balance or a count correction has no supplier batch behind it.
  // Refusing it would make lot tracking a breaking change for existing stock.
  const { lotId } = await receiveStock({
    commandId: uid("recv"),
    itemId: SHEET,
    locationId: STORES,
    quantity: 10,
  });
  assert.equal(lotId, null);

  const { lots, unlottedRemaining } = await lotsFor(SHEET, STORES);
  assert.equal(lots.length, 0);
  assert.equal(unlottedRemaining, 10, "it must be reported, not silently dropped");
});

test("L3 per-lot remaining is derived and agrees with the balance", async () => {
  await receiveLot(25, "EB7728", "307290-1", 60);
  await receiveLot(15, "EB9001", "307290-2", 30);

  const { lots, unlottedRemaining } = await lotsFor(SHEET, STORES);
  assert.equal(lots.length, 2);
  assert.equal(
    lots.reduce((s, l) => s + l.remaining, 0) + unlottedRemaining,
    (await balance()).onHand,
    "the derived sum IS the balance, or storing neither was pointless"
  );
});

test("L4 an issue takes the oldest lot first", async () => {
  await receiveLot(25, "EB7728", "307290-1", 60); // older
  await receiveLot(15, "EB9001", "307290-2", 30); // newer

  await issue(10);

  const { lots } = await lotsFor(SHEET, STORES);
  const oldest = lots.find((l) => l.batchNumber === "307290-1")!;
  const newest = lots.find((l) => l.batchNumber === "307290-2")!;
  assert.equal(oldest.remaining, 15);
  assert.equal(newest.remaining, 15, "the newer lot should be untouched");
});

test("L5 an issue spanning two lots writes one movement per lot", async () => {
  await receiveLot(25, "EB7728", "307290-1", 60);
  await receiveLot(15, "EB9001", "307290-2", 30);

  await issue(40); // empties the first, takes all of the second

  const movements = await issueMovements();
  assert.equal(movements.length, 2, "one aggregated row would destroy the trace");
  assert.equal(
    movements.reduce((s, m) => s + m.quantity, 0),
    -40,
    "and the two must still sum to what left"
  );
  assert.ok(movements.every((m) => m.lotId !== null));

  const { lots } = await lotsFor(SHEET, STORES);
  assert.equal(lots.reduce((s, l) => s + l.remaining, 0), 0);
  assert.equal((await balance()).onHand, 0);
});

test("L6 a lot is never drawn below zero", async () => {
  await receiveLot(10, "EB7728", "307290-1", 60);
  await receiveLot(10, "EB9001", "307290-2", 30);
  await issue(20);

  const { lots } = await lotsFor(SHEET, STORES);
  assert.ok(lots.every((l) => l.remaining >= 0), lots.map((l) => l.remaining).join(","));
});

test("L7 issuing more than the lots hold falls back to unlotted rather than refusing", async () => {
  // 10 lotted, 10 received with no lot. An issue of 15 must draw the lot first and
  // then the unlotted remainder — refusing would make pre-existing stock unusable.
  await receiveLot(10, "EB7728", "307290-1", 60);
  await receiveStock({ commandId: uid("recv"), itemId: SHEET, locationId: STORES, quantity: 10 });

  await issue(15);

  const movements = await issueMovements();
  assert.equal(movements.length, 2);
  const lotted = movements.find((m) => m.lotId !== null)!;
  const unlotted = movements.find((m) => m.lotId === null)!;
  assert.equal(lotted.quantity, -10);
  assert.equal(unlotted.quantity, -5);
});

test("L8 a return goes back to the lot it came out of, not to the oldest", async () => {
  await receiveLot(10, "EB7728", "307290-1", 60); // oldest
  await receiveLot(10, "EB9001", "307290-2", 30);

  await issue(15); // 10 from the old lot, 5 from the new one
  await returnMaterial({
    commandId: uid("ret"),
    requirementId: REQ,
    itemId: SHEET,
    locationId: STORES,
    quantity: 5,
  });

  const { lots } = await lotsFor(SHEET, STORES);
  const newest = lots.find((l) => l.batchNumber === "307290-2")!;
  const oldest = lots.find((l) => l.batchNumber === "307290-1")!;
  // The 5 that came back were the 5 taken most recently — from the NEWER lot.
  // Crediting the oldest would invent stock of a heat that was fully consumed.
  assert.equal(newest.remaining, 10);
  assert.equal(oldest.remaining, 0);
});

test("L9 a duplicate batch number is refused, because a scan has to resolve to one lot", async () => {
  await receiveLot(10, "EB7728", "307290-1", 60);
  await assert.rejects(
    () => receiveLot(10, "EB9999", "307290-1", 30),
    (err: unknown) => err instanceof CommandError && err.code === "DUPLICATE_BATCH"
  );
});

test("L10 a batch number resolves to its lot — what a barcode scan does", async () => {
  const { lotId } = await receiveLot(10, "EB7728", "307290-1", 60);
  const found = await lotByBatch("  307290-1  ");
  assert.equal(found?.id, lotId, "a scanner appends whitespace; it must still resolve");
  assert.equal(await lotByBatch("no-such-batch"), null);
});

test("L11 which heats went into an operation is answerable", async () => {
  await receiveLot(25, "EB7728", "307290-1", 60);
  await receiveLot(15, "EB9001", "307290-2", 30);
  await issue(30); // 25 from EB7728, 5 from EB9001

  const { lots, unlottedQuantity } = await lotsConsumedBy(TASK);
  assert.equal(unlottedQuantity, 0);
  const byHeat = Object.fromEntries(lots.map((l) => [l.heatNumber, l.quantity]));
  assert.deepEqual(byHeat, { EB7728: 25, EB9001: 5 });
});

test("L12 an untraceable issue is reported as unknown, not omitted", async () => {
  // This is the case that matters for honesty. Stock received before lot tracking
  // has no heat, and a trace that silently leaves it out looks complete and is not.
  await receiveStock({ commandId: uid("recv"), itemId: SHEET, locationId: STORES, quantity: 20 });
  await issue(20);

  const { lots, unlottedQuantity } = await lotsConsumedBy(TASK);
  assert.equal(lots.length, 0);
  assert.equal(unlottedQuantity, 20);
});

test("L13 a replayed receipt returns the lot the first attempt created", async () => {
  const command = uid("recv");
  const payload = {
    commandId: command,
    itemId: SHEET,
    locationId: STORES,
    quantity: 10,
    lot: { heatNumber: "EB7728", batchNumber: "307290-1", receivedAt: new Date("2026-09-01") },
  };
  const first = await receiveStock(payload);
  const second = await receiveStock(payload);

  assert.equal(second.lotId, first.lotId, "a retry printing a label must not print a null lot");
  const rows = await db.select().from(stockLots);
  assert.equal(rows.length, 1, "and the replay must not create a second lot");
  assert.equal((await balance()).onHand, 10);
});
