import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { resetDatabase, uid } from "./helpers";
import {
  items,
  stations,
  workOrders,
  workOrderTasks,
  inventoryLocations,
  materialRequirements,
  reasonCodes,
  qualityEvents,
  inventoryBalances,
} from "../src/db/schema";
import {
  receiveStock,
  reserveForRequirement,
  issueAgainstReservation,
  scrapIssuedMaterial,
  coverageFor,
  reconcile,
  CommandError,
} from "../src/lib/inventory";
import { blockersFor } from "../src/lib/dependencies";

/*
  Material that is already out on a job, found unusable at the bench.

  Distinct from writing off a pallet in stores: the stock has already left the
  shelf, so nothing on the shelf may move again.
*/

let locationId: number;
let itemId: number;
let requirementId: number;
let operationId: number;
let reasonId: number;

beforeEach(async () => {
  await resetDatabase();

  const [loc] = await db
    .insert(inventoryLocations)
    .values({ code: `L-${uid("wip")}`, name: "Stores" })
    .returning();
  locationId = loc.id;

  const [sheet] = await db
    .insert(items)
    .values({ sku: `SHEET-${uid("wip")}`, name: "Galvanised sheet", procurementType: "PURCHASED" })
    .returning();
  itemId = sheet.id;

  const [product] = await db
    .insert(items)
    .values({ sku: `AHU-${uid("wip")}`, name: "Unit", procurementType: "MANUFACTURED" })
    .returning();

  const [station] = await db
    .insert(stations)
    .values({ name: `Fab-${uid("wip")}`, number: 10 })
    .returning();

  const [order] = await db
    .insert(workOrders)
    .values({ orderNumber: `WO-${uid("wip")}`, itemId: product.id, quantity: 1 })
    .returning();

  const [task] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: order.id,
      sequence: 1,
      name: "Shear & form",
      stationId: station.id,
      expectedMinutes: 60,
    })
    .returning();
  operationId = task.id;

  const [req] = await db
    .insert(materialRequirements)
    .values({ operationId: task.id, itemId: sheet.id, requiredQty: 10 })
    .returning();
  requirementId = req.id;

  const [reason] = await db
    .insert(reasonCodes)
    .values({ category: "SCRAP", code: `MAT-${uid("wip")}`, label: "Material defect" })
    .returning();
  reasonId = reason.id;

  // Ten sheets received, reserved and drawn to the bench.
  await receiveStock({ commandId: uid("wip"), itemId, locationId, quantity: 10 });
  await reserveForRequirement({ commandId: uid("wip"), requirementId, itemId, locationId, quantity: 10 });
  await issueAgainstReservation({ commandId: uid("wip"), requirementId, itemId, locationId, quantity: 10 });
});

after(async () => {
  await pool.end();
});

test("scrapping material at the bench does NOT move stock again", async () => {
  const [before] = await db
    .select()
    .from(inventoryBalances)
    .where(eq(inventoryBalances.itemId, itemId));

  await scrapIssuedMaterial({
    commandId: uid("wip"),
    requirementId,
    quantity: 3,
    reasonCodeId: reasonId,
  });

  const [after_] = await db
    .select()
    .from(inventoryBalances)
    .where(eq(inventoryBalances.itemId, itemId));

  assert.equal(after_.onHand, before.onHand, "the sheet already left stores at issue");
  assert.deepEqual(await reconcile(), [], "the ledger still agrees with itself");
});

test("the step is short again, without anyone re-blocking it", async () => {
  const before = await blockersFor(operationId);
  assert.equal(
    before.filter((b) => b.kind === "MATERIAL").length,
    0,
    "fully supplied to begin with"
  );

  await scrapIssuedMaterial({
    commandId: uid("wip"),
    requirementId,
    quantity: 4,
    reasonCodeId: reasonId,
  });

  const cover = await coverageFor(requirementId);
  assert.equal(cover.netIssued, 6, "issued minus scrapped");

  const after_ = await blockersFor(operationId);
  const material = after_.find((b) => b.kind === "MATERIAL");
  assert.ok(material, "the step reports itself short again on its own");
  assert.equal(material.shortBy, 4);
});

test("the write-off records what, how many, why and which batch", async () => {
  await scrapIssuedMaterial({
    commandId: uid("wip"),
    requirementId,
    quantity: 2,
    reasonCodeId: reasonId,
  });

  const [event] = await db
    .select()
    .from(qualityEvents)
    .where(eq(qualityEvents.workOrderTaskId, operationId));

  assert.equal(event.type, "SCRAP");
  assert.equal(event.quantity, 2);
  assert.equal(event.itemId, itemId, "names the MATERIAL, not the product");
  assert.equal(event.reasonCodeId, reasonId);
});

test("you cannot throw away more than you were given", async () => {
  await assert.rejects(
    () =>
      scrapIssuedMaterial({
        commandId: uid("wip"),
        requirementId,
        quantity: 11,
        reasonCodeId: reasonId,
      }),
    (e) => e instanceof CommandError && /Only 10/.test(e.message)
  );
});

test("scrapping twice cannot exceed what is on the bench", async () => {
  await scrapIssuedMaterial({ commandId: uid("wip"), requirementId, quantity: 6, reasonCodeId: reasonId });
  await assert.rejects(
    () =>
      scrapIssuedMaterial({
        commandId: uid("wip"),
        requirementId,
        quantity: 5,
        reasonCodeId: reasonId,
      }),
    (e) => e instanceof CommandError && /Only 4/.test(e.message)
  );
});

test("a replayed write-off applies once", async () => {
  const commandId = uid("wip");
  await scrapIssuedMaterial({ commandId, requirementId, quantity: 3, reasonCodeId: reasonId });
  await scrapIssuedMaterial({ commandId, requirementId, quantity: 3, reasonCodeId: reasonId });

  const [req] = await db
    .select()
    .from(materialRequirements)
    .where(eq(materialRequirements.id, requirementId));
  assert.equal(req.scrappedFromWipQty, 3, "a double tap writes off once");
});

test("a quantity that is not a quantity is refused", async () => {
  await assert.rejects(
    () =>
      scrapIssuedMaterial({
        commandId: uid("wip"),
        requirementId,
        quantity: 0,
        reasonCodeId: reasonId,
      }),
    (e) => e instanceof CommandError
  );
});
