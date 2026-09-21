import "dotenv/config";
import { randomUUID } from "node:crypto";
import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { items, users, stations, routingSteps, workOrders, workOrderTasks,
  inventoryLocations, inventoryBalances, inventoryMovements, materialRequirements,
  operationDependencies, taskEvents } from "../src/db/schema.ts";
import { receiveStock, placeHold, coverageFor } from "../src/lib/inventory.ts";
import { resetDatabase } from "./helpers.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) throw new Error("Use mes_test only");
let user: { id: number; name: string; email: string; stationId: number; role: "SUPERVISOR" | "WORKER" } | null;
mock.module("../src/lib/session.ts", { namedExports: {
  requireRole: async (...roles: string[]) => {
    if (!user || !roles.includes(user.role)) throw new Error("Not permitted");
    return user;
  },
  requireUser: async () => { if (!user) throw new Error("Not signed in"); return user; },
  isManager: (role: string) => role === "SUPERVISOR" || role === "ADMIN",
} });
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
let reserveMaterial: typeof import("../src/app/actions/materials.ts").reserveMaterial;
let startTask: typeof import("../src/app/actions/tasks.ts").startTask;
let itemId: number, locationId: number, requirementId: number, taskId: number, orderId: number;
before(async () => {
  ({ reserveMaterial } = await import("../src/app/actions/materials.ts"));
  ({ startTask } = await import("../src/app/actions/tasks.ts"));
});
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDatabase();
  const [station] = await db.insert(stations).values({ name: "Assembly" }).returning();
  const [person] = await db.insert(users).values({ name: "Planner", email: "planner@test.invalid",
    passwordHash: "x", role: "SUPERVISOR", stationId: station.id }).returning();
  user = { id: person.id, name: person.name, email: person.email, role: "SUPERVISOR", stationId: station.id };
  const [item] = await db.insert(items).values({ sku: "MOTOR", name: "Motor", procurementType: "PURCHASED" }).returning();
  itemId = item.id;
  const [location] = await db.insert(inventoryLocations).values({ code: "MAIN", name: "Stores" }).returning();
  locationId = location.id;
  const [step] = await db.insert(routingSteps).values({ itemId, sequence: 1, name: "Fit motor", stationId: station.id }).returning();
  const [order] = await db.insert(workOrders).values({ orderNumber: "PLAN-1", itemId, quantity: 1, status: "RELEASED" }).returning();
  orderId = order.id;
  const [task] = await db.insert(workOrderTasks).values({ workOrderId: orderId, routingStepId: step.id,
    sequence: 1, name: "Fit motor", stationId: station.id }).returning();
  taskId = task.id;
  const [req] = await db.insert(materialRequirements).values({ operationId: taskId, itemId, requiredQty: 10 }).returning();
  requirementId = req.id;
});
const receive = (quantity: number) => receiveStock({ commandId: randomUUID(), itemId, locationId, quantity });
const reserve = (commandId = randomUUID()) => reserveMaterial({ requirementId, commandId });
const balance = async () => (await db.select().from(inventoryBalances).where(eq(inventoryBalances.itemId, itemId)))[0];

test("reservation keeps stock on hand and does not start work", async () => {
  await receive(20);
  const result = await reserve();
  assert.deepEqual(result, { ok: true, result: { reserved: 10, uncovered: 0, orderId } });
  assert.equal((await balance()).onHand, 20);
  assert.equal((await balance()).activeReserved, 10);
  assert.equal((await db.select().from(workOrderTasks))[0].status, "PENDING");
  assert.equal((await db.select().from(inventoryMovements)).length, 1);
  assert.equal((await db.select().from(taskEvents))[0].actorUserId, user!.id);
});
test("workers and signed-out callers cannot reserve", async () => {
  await receive(20);
  user!.role = "WORKER";
  assert.equal((await reserve()).ok, false);
  user = null;
  assert.equal((await reserve()).ok, false);
  assert.equal((await balance()).activeReserved, 0);
});
test("partial reservation excludes held stock and reports the remainder", async () => {
  await receive(8);
  await placeHold({ commandId: randomUUID(), itemId, locationId, quantity: 3, reason: "Inspection" });
  assert.deepEqual(await reserve(), { ok: true, result: { reserved: 5, uncovered: 5, orderId } });
});
test("replay returns original result even after fresh stock arrives", async () => {
  await receive(4);
  const key = randomUUID();
  const original = await reserve(key);
  await receive(10);
  assert.deepEqual(await reserve(key), original);
  assert.equal((await reserveMaterial({ requirementId: requirementId + 1, commandId: key })).ok, false);
  assert.equal((await balance()).activeReserved, 4);
  assert.deepEqual(await reserve(), { ok: true, result: { reserved: 6, uncovered: 0, orderId } });
});
test("concurrent requests cannot reserve more than remaining demand", async () => {
  await receive(30);
  const results = await Promise.all([reserve(), reserve()]);
  assert.ok(results.every(r => r.ok));
  assert.equal((await balance()).activeReserved, 10);
  assert.equal((await coverageFor(requirementId)).uncovered, 0);
});
test("concurrent identical requests return one original reservation", async () => {
  await receive(30);
  const key = randomUUID();
  const [a, b] = await Promise.all([reserve(key), reserve(key)]);
  assert.equal(a.ok, true);
  assert.deepEqual(a, b);
  assert.equal((await balance()).activeReserved, 10);
  assert.equal((await db.select().from(taskEvents)).length, 1);
});
test("closed orders and sub-assembly demand cannot reserve stock", async () => {
  await receive(20);
  await db.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, orderId));
  assert.equal((await reserve()).ok, false);
  await db.update(workOrders).set({ status: "RELEASED" }).where(eq(workOrders.id, orderId));
  await db.insert(operationDependencies).values({ operationId: taskId, type: "REQUIRED_QUANTITY", requirementId, requiredQuantity: 10 });
  assert.equal((await reserve()).ok, false);
  assert.equal((await balance()).activeReserved, 0);
});
test("start keeps the planned reservation and draws nothing, however often it is tapped", async () => {
  // The planner's reservation is a commitment, not a withdrawal. Start no longer
  // turns it into one — the handler does that by scanning the batch they lift.
  await receive(20);
  assert.equal((await reserve()).ok, true);
  const key = randomUUID();
  assert.equal((await startTask(taskId, key)).ok, true);
  assert.equal((await startTask(taskId, key)).ok, true);
  assert.equal((await balance()).onHand, 20, "still on the shelf");
  assert.equal((await balance()).activeReserved, 10, "still committed, not consumed");
});
