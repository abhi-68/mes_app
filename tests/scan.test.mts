import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "../src/db/index.ts";
import { items, stockLots, workOrders, workOrderTasks } from "../src/db/schema.ts";
import { resetDatabase } from "./helpers.ts";
import { operationCode, parseOperationCode, resolveScan } from "../src/lib/scan.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

after(async () => {
  await pool.end();
});

let taskId = 0;
let orderId = 0;

beforeEach(async () => {
  await resetDatabase();
  const [item] = await db
    .insert(items)
    .values({ sku: "FG-AHU", name: "Air Handling Unit", procurementType: "MANUFACTURED" })
    .returning();
  const [order] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-260920-001", itemId: item.id, quantity: 1, status: "RELEASED" })
    .returning();
  orderId = order.id;
  const [task] = await db
    .insert(workOrderTasks)
    .values({ workOrderId: order.id, sequence: 1, name: "Mount panels" })
    .returning();
  taskId = task.id;
  await db
    .insert(stockLots)
    .values({ itemId: item.id, batchNumber: "307290-4", heatNumber: "EB7728" });
});

test("an operation code round-trips", () => {
  assert.equal(operationCode(482), "OP-482");
  assert.equal(parseOperationCode("OP-482"), 482);
  assert.equal(parseOperationCode("op-482"), 482, "scanners are not case-consistent");
  assert.equal(parseOperationCode("  OP-482  "), 482, "whitespace from a gun is stripped");
});

test("things that only look like an operation code are refused", () => {
  for (const bad of ["OP-", "OP-0", "OP-abc", "OPS-1", "WO-260920-001", "", "OP--1", "OP-1.5"]) {
    assert.equal(parseOperationCode(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("scanning a traveler resolves to that step", async () => {
  const target = await resolveScan(`OP-${taskId}`);
  assert.equal(target.kind, "operation");
  if (target.kind !== "operation") return;
  assert.equal(target.operationId, taskId);
  assert.equal(target.orderId, orderId);
  assert.match(target.label, /Mount panels/);
  assert.match(target.label, /WO-260920-001/);
});

test("scanning a work order number resolves to the order", async () => {
  const target = await resolveScan("WO-260920-001");
  assert.equal(target.kind, "order");
  if (target.kind !== "order") return;
  assert.equal(target.orderId, orderId);
});

test("scanning a batch label resolves to the lot", async () => {
  const target = await resolveScan("307290-4");
  assert.equal(target.kind, "lot");
  if (target.kind !== "lot") return;
  assert.equal(target.batchNumber, "307290-4");
});

test("an operation code for a step that does not exist is unknown, not a crash", async () => {
  const target = await resolveScan("OP-999999");
  assert.equal(target.kind, "unknown");
});

test("an unrecognised code is reported rather than guessed at", async () => {
  for (const code of ["", "   ", "NOT-A-CODE", "'; drop table work_orders; --"]) {
    const target = await resolveScan(code);
    assert.equal(target.kind, "unknown", `${JSON.stringify(code)} should not resolve`);
  }
  // The injection attempt above must not have done anything.
  const still = await db.select().from(workOrders);
  assert.equal(still.length, 1, "the orders table is intact");
});
