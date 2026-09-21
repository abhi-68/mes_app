import "dotenv/config";
import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import {
  items, users, stations, routingSteps, workOrders, workOrderTasks,
  inventoryLocations, inventoryBalances, inventoryMovements, materialRequirements,
} from "../src/db/schema.ts";
import { receiveStock } from "../src/lib/inventory.ts";
import { pickListFor } from "../src/lib/picking.ts";
import { resetDatabase } from "./helpers.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

/**
 * Picking material by scanning the batch.
 *
 * Starting a step used to draw the material too, oldest batch first, with nobody
 * looking at a rack. These tests hold the new shape: Start commits stock and stops;
 * the handler collects it and scans what they actually lifted.
 */

let user: { id: number; name: string; email: string; stationId: number; role: "WORKER" } | null;
mock.module("../src/lib/session.ts", {
  namedExports: {
    requireRole: async (...roles: string[]) => {
      if (!user || !roles.includes(user.role)) throw new Error("Not permitted");
      return user;
    },
    requireUser: async () => {
      if (!user) throw new Error("Not signed in");
      return user;
    },
    getCurrentUser: async () => user,
    isManager: (role: string) => role === "SUPERVISOR" || role === "ADMIN",
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

let pickMaterial: typeof import("../src/app/actions/picking.ts").pickMaterial;
let startTask: typeof import("../src/app/actions/tasks.ts").startTask;

let ITEM = 0, LOC = 0, TASK = 0, REQ = 0;
let BATCH_A = "", BATCH_B = "";
let OTHER_BATCH = "";

before(async () => {
  ({ pickMaterial } = await import("../src/app/actions/picking.ts"));
  ({ startTask } = await import("../src/app/actions/tasks.ts"));
});
after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
  const [station] = await db.insert(stations).values({ name: "Frame Fab" }).returning();
  const [person] = await db.insert(users).values({
    name: "Priya Nair", email: "priya@test.invalid", passwordHash: "x",
    role: "WORKER", stationId: station.id,
  }).returning();
  user = { id: person.id, name: person.name, email: person.email, role: "WORKER", stationId: station.id };

  const [sheet] = await db.insert(items).values({
    sku: "RAW-GALV-16", name: "Galvanized Sheet", procurementType: "PURCHASED", unitOfMeasure: "sheet",
  }).returning();
  const [tube] = await db.insert(items).values({
    sku: "RAW-CU-TUBE", name: "Copper Tube", procurementType: "PURCHASED", unitOfMeasure: "ft",
  }).returning();
  ITEM = sheet.id;

  const [loc] = await db.insert(inventoryLocations).values({ code: "MAIN", name: "Stores" }).returning();
  LOC = loc.id;

  const [step] = await db.insert(routingSteps).values({
    itemId: ITEM, sequence: 1, name: "Cut skins", stationId: station.id,
  }).returning();
  const [order] = await db.insert(workOrders).values({
    orderNumber: "WO-1", itemId: ITEM, quantity: 1, status: "RELEASED",
  }).returning();
  const [task] = await db.insert(workOrderTasks).values({
    workOrderId: order.id, routingStepId: step.id, sequence: 1,
    name: "Cut skins", stationId: station.id,
  }).returning();
  TASK = task.id;
  const [req] = await db.insert(materialRequirements).values({
    operationId: TASK, itemId: ITEM, requiredQty: 10,
  }).returning();
  REQ = req.id;

  // Two batches of the right part, one of something else entirely.
  BATCH_A = "307290-1";
  BATCH_B = "307290-2";
  OTHER_BATCH = "CU-88213-A";
  await receiveStock({ commandId: randomUUID(), itemId: ITEM, locationId: LOC, quantity: 6, lot: { batchNumber: BATCH_A, heatNumber: "EB7728" } });
  await receiveStock({ commandId: randomUUID(), itemId: ITEM, locationId: LOC, quantity: 20, lot: { batchNumber: BATCH_B, heatNumber: "EB9014" } });
  await receiveStock({ commandId: randomUUID(), itemId: tube.id, locationId: LOC, quantity: 50, lot: { batchNumber: OTHER_BATCH } });
});

const balance = async () =>
  (await db.select().from(inventoryBalances)
    .where(and(eq(inventoryBalances.itemId, ITEM), eq(inventoryBalances.locationId, LOC))))[0];

const pick = (batchNumber: string, quantity: number) =>
  pickMaterial({ commandId: randomUUID(), operationId: TASK, requirementId: REQ, batchNumber, quantity });

const line = async () => (await pickListFor(TASK))[0];

// --- Start no longer deducts --------------------------------------------

test("starting a step commits the material but takes nothing off the shelf", async () => {
  const before = await balance();
  assert.equal(before.onHand, 26);

  assert.equal((await startTask(TASK, randomUUID())).ok, true);

  const after = await balance();
  assert.equal(after.onHand, 26, "stock is still on the rack");
  assert.equal(after.activeReserved, 10, "and committed to this step");
  assert.equal((await db.select().from(inventoryMovements).where(eq(inventoryMovements.type, "ISSUE"))).length, 0);
});

test("the step still refuses to start when the material is not there", async () => {
  await db.update(materialRequirements).set({ requiredQty: 999 }).where(eq(materialRequirements.id, REQ));
  const res = await startTask(TASK, randomUUID());
  assert.equal(res.ok, false);
  assert.equal((await balance()).activeReserved, 0, "and commits nothing");
});

test("the pick list says what to go and get", async () => {
  await startTask(TASK, randomUUID());
  const l = await line();
  assert.equal(l.itemName, "Galvanized Sheet");
  assert.equal(l.required, 10);
  assert.equal(l.taken, 0);
  assert.equal(l.outstanding, 10);
  assert.equal(l.reserved, 10);
});

// --- Picking -------------------------------------------------------------

test("scanning a batch takes it from THAT batch, and records it as confirmed", async () => {
  await startTask(TASK, randomUUID());
  const res = await pick(BATCH_B, 10);
  assert.equal(res.ok, true);

  const after = await balance();
  assert.equal(after.onHand, 16, "10 left the shelf");
  assert.equal((await line()).outstanding, 0);

  const [m] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.type, "ISSUE"));
  assert.equal(m.quantity, -10);
  assert.equal(m.lotAssumed, false, "somebody looked at the label");
});

test("a pick can be split across batches, one movement each", async () => {
  await startTask(TASK, randomUUID());
  assert.equal((await pick(BATCH_A, 6)).ok, true, "empty the small one");
  assert.equal((await line()).outstanding, 4);
  assert.equal((await pick(BATCH_B, 4)).ok, true);
  assert.equal((await line()).outstanding, 0);

  const moves = await db.select().from(inventoryMovements).where(eq(inventoryMovements.type, "ISSUE"));
  assert.equal(moves.length, 2, "two batches, two rows — the trace keeps both heats");
  assert.equal((await balance()).onHand, 16);
});

test("the wrong pallet is refused by name, not by code", async () => {
  await startTask(TASK, randomUUID());
  const res = await pick(OTHER_BATCH, 1);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /Copper Tube/, "it says what is in your hands");
  assert.match(res.error, /different part/);
  assert.equal((await line()).taken, 0);
});

test("a batch cannot give more than it holds", async () => {
  await startTask(TASK, randomUUID());
  const res = await pick(BATCH_A, 7);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /only 6 left/);
});

test("you cannot take more than the step needs", async () => {
  await startTask(TASK, randomUUID());
  const res = await pick(BATCH_B, 11);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /needs only 10 more/);
});

test("once the step has everything, a further pick is refused", async () => {
  await startTask(TASK, randomUUID());
  await pick(BATCH_B, 10);
  const res = await pick(BATCH_B, 1);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already has everything/);
});

test("an unknown label is reported rather than guessed at", async () => {
  await startTask(TASK, randomUUID());
  const res = await pick("NOT-A-BATCH", 1);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /No batch is labelled/);
});

test("a double-tap on the scanner takes the material once", async () => {
  await startTask(TASK, randomUUID());
  const once = { commandId: randomUUID(), operationId: TASK, requirementId: REQ, batchNumber: BATCH_B, quantity: 5 };
  assert.equal((await pickMaterial(once)).ok, true);
  assert.equal((await pickMaterial(once)).ok, true, "the replay is not an error");

  assert.equal((await balance()).onHand, 21, "5 taken, not 10");
  assert.equal((await line()).taken, 5);
});

test("picking can happen without starting first — it tops up the commitment", async () => {
  // A handler who collects before pressing Start is not doing anything wrong.
  assert.equal((await balance()).activeReserved, 0);
  assert.equal((await pick(BATCH_B, 4)).ok, true);
  assert.equal((await line()).taken, 4);
  assert.equal((await balance()).onHand, 22);
});

test("a finished step cannot have material drawn against it", async () => {
  await db.update(workOrderTasks).set({ status: "DONE" }).where(eq(workOrderTasks.id, TASK));
  const res = await pick(BATCH_B, 1);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already finished/);
});

test("someone at another station cannot draw this step's material", async () => {
  const [other] = await db.insert(stations).values({ name: "Coil Line" }).returning();
  user!.stationId = other.id;
  const res = await pick(BATCH_B, 1);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /Switch/i);
  assert.equal((await line()).taken, 0);
});

test("signed out, nothing can be drawn", async () => {
  user = null;
  assert.equal((await pick(BATCH_B, 1)).ok, false);
});
