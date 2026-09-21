import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { resetDatabase } from "./helpers.ts";
import {
  items, stations, routingSteps, workOrders, workOrderTasks,
  materialRequirements, operationDependencies,
} from "../src/db/schema.ts";
import {
  deliverCompletedSubAssembly, outputStateFor, satisfiedQuantityFor,
} from "../src/lib/outputs.ts";
import { blockersForOperations } from "../src/lib/dependencies.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

after(async () => {
  await pool.end();
});

/**
 * The inspection gate.
 *
 * `items.requiresInspection` was in the schema with a careful comment and was read
 * by nothing, so every sub-assembly was accepted the moment its step was finished.
 * These tests are the difference between that comment being true and being a wish.
 */

let parentOp = 0;
let childOp = 0;
let requirementId = 0;

/** Builds a parent that needs `qty` of a child, and returns the child's step. */
async function build(childRequiresInspection: boolean, qty = 2) {
  await resetDatabase();
  const [station] = await db.insert(stations).values({ name: "Panel Fab" }).returning();

  const [child] = await db.insert(items).values({
    sku: "SUB-PANEL", name: "Insulated Panel", procurementType: "MANUFACTURED",
    requiresInspection: childRequiresInspection,
  }).returning();
  const [parent] = await db.insert(items).values({
    sku: "FG-AHU", name: "Air Handling Unit", procurementType: "MANUFACTURED",
    isFinishedGood: true,
  }).returning();

  const [parentStep] = await db.insert(routingSteps).values({
    itemId: parent.id, sequence: 1, name: "Mount panels", stationId: station.id,
  }).returning();
  const [childStep] = await db.insert(routingSteps).values({
    itemId: child.id, sequence: 1, name: "Close double-wall", stationId: station.id,
  }).returning();

  const [parentOrder] = await db.insert(workOrders).values({
    orderNumber: "WO-AHU", itemId: parent.id, quantity: 1, status: "RELEASED",
  }).returning();
  const [childOrder] = await db.insert(workOrders).values({
    orderNumber: "WO-AHU-01", itemId: child.id, quantity: qty, status: "RELEASED",
    parentWorkOrderId: parentOrder.id,
  }).returning();

  const [pTask] = await db.insert(workOrderTasks).values({
    workOrderId: parentOrder.id, routingStepId: parentStep.id, sequence: 1,
    name: "Mount panels", stationId: station.id,
  }).returning();
  const [cTask] = await db.insert(workOrderTasks).values({
    workOrderId: childOrder.id, routingStepId: childStep.id, sequence: 1,
    name: "Close double-wall", stationId: station.id,
  }).returning();

  const [req] = await db.insert(materialRequirements).values({
    operationId: pTask.id, itemId: child.id, requiredQty: qty,
  }).returning();

  await db.insert(operationDependencies).values({
    operationId: pTask.id, dependsOnOperationId: cTask.id,
    type: "REQUIRED_QUANTITY", requirementId: req.id, requiredQuantity: qty,
  });

  parentOp = pTask.id;
  childOp = cTask.id;
  requirementId = req.id;
}

const parentIsBlocked = async () =>
  ((await blockersForOperations([parentOp])).get(parentOp) ?? []).length > 0;

beforeEach(async () => {
  await build(false);
});

test("a part with no inspection requirement is accepted and allocated on completion", async () => {
  await deliverCompletedSubAssembly({ operationId: childOp });

  const s = await outputStateFor(childOp);
  assert.equal(s.produced, 2);
  assert.equal(s.pendingInspection, 0, "nothing left waiting");
  assert.equal(s.accepted, 2);
  assert.equal(await satisfiedQuantityFor(requirementId), 2, "the parent has its panels");
  assert.equal(await parentIsBlocked(), false, "so the parent can start");
});

test("an inspected part is produced but NOT accepted, and the parent stays blocked", async () => {
  await build(true);
  await deliverCompletedSubAssembly({ operationId: childOp });

  const s = await outputStateFor(childOp);
  assert.equal(s.produced, 2, "the work was done");
  assert.equal(s.pendingInspection, 2, "and is waiting on an inspector");
  assert.equal(s.accepted, 0, "nobody accepted it by finishing the step");
  assert.equal(s.allocatedOutstanding, 0, "so it was never allocated");
  assert.equal(await satisfiedQuantityFor(requirementId), 0);
  assert.equal(await parentIsBlocked(), true, "final assembly cannot consume it yet");
});

test("the gate is not a one-off: completing again does not sneak it through", async () => {
  await build(true);
  await deliverCompletedSubAssembly({ operationId: childOp });
  await deliverCompletedSubAssembly({ operationId: childOp });

  const s = await outputStateFor(childOp);
  assert.equal(s.accepted, 0, "still nobody has inspected it");
  assert.equal(await satisfiedQuantityFor(requirementId), 0);
  assert.equal(await parentIsBlocked(), true);
});

test("once inspected and accepted, the held quantity flows to the parent", async () => {
  await build(true);
  await deliverCompletedSubAssembly({ operationId: childOp });

  // What the /quality screen does: pass it, then hand it to the operation waiting.
  const { inspectOutput, allocateOutput } = await import("../src/lib/outputs.ts");
  await inspectOutput({
    commandId: "insp-1", operationId: childOp,
    from: "pendingInspection", to: "accepted", quantity: 2,
  });
  await allocateOutput({
    commandId: "alloc-1", operationId: childOp, requirementId, quantity: 2,
  });

  const s = await outputStateFor(childOp);
  assert.equal(s.accepted, 2);
  assert.equal(s.pendingInspection, 0);
  assert.equal(await satisfiedQuantityFor(requirementId), 2);
  assert.equal(await parentIsBlocked(), false, "the parent is released by the inspector");
});

test("a rejected part is scrapped and never reaches the parent", async () => {
  await build(true);
  await deliverCompletedSubAssembly({ operationId: childOp });

  const { inspectOutput } = await import("../src/lib/outputs.ts");
  await inspectOutput({
    commandId: "insp-scrap", operationId: childOp,
    from: "pendingInspection", to: "scrapped", quantity: 2, reason: "Bowed skin",
  });

  const s = await outputStateFor(childOp);
  assert.equal(s.scrapped, 2);
  assert.equal(s.accepted, 0);
  assert.equal(s.produced, 2, "produced is history and does not shrink");
  assert.equal(await satisfiedQuantityFor(requirementId), 0);
  assert.equal(await parentIsBlocked(), true, "the shortage is still real");
});

test("the flag is per item, so one inspected part does not gate an uninspected one", async () => {
  await build(false);
  await deliverCompletedSubAssembly({ operationId: childOp });
  assert.equal((await outputStateFor(childOp)).accepted, 2);

  const [row] = await db.select().from(items).where(eq(items.sku, "SUB-PANEL"));
  assert.equal(row.requiresInspection, false, "the fixture really did vary the flag");
});
