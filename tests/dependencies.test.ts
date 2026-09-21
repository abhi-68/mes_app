import "dotenv/config";
import { test, beforeEach, after } from "node:test";
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
  bomLines,
  inventoryLocations,
  materialRequirements,
  operationDependencies,
} from "../src/db/schema";
import { releaseWorkOrder } from "../src/lib/work-orders";
import { blockersFor, waitingOperations } from "../src/lib/dependencies";
import {
  reportProduction,
  inspectOutput,
  allocateOutput,
  issueOutputToParent,
  returnOutputFromParent,
  holdOutput,
  releaseOutputHold,
} from "../src/lib/outputs";
import { receiveStock } from "../src/lib/inventory";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

/**
 * A deliberately convergent fixture, because that is the shape Thermal Corp
 * described: a sub-assembly built in parallel, meeting the main unit at
 * assembly time.
 *
 *   AHU  step 1  Build frame
 *        step 2  Fit fan section      <- consumes 1x FAN (manufactured)
 *        step 3  Run test
 *
 *   FAN  step 1  Assemble fan         <- consumes 1x MOTOR (purchased)
 */
let AHU = 0;
let FAN = 0;
let MOTOR = 0;
let STORES = 0;

let frameOp = 0;
let fitFanOp = 0;
let testOp = 0;
let fanOp = 0;
let fanRequirementId = 0;

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();

  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();
  STORES = stores.id;

  const [ahu, fan, motor] = await db
    .insert(items)
    .values([
      {
        sku: "CF-3000-H",
        name: "Air Handler CF-3000",
        procurementType: "MANUFACTURED" as const,
        isFinishedGood: true,
      },
      { sku: "SUB-FAN-01", name: "Fan Section", procurementType: "MANUFACTURED" as const },
      { sku: "BUY-MOTOR-5HP", name: "5HP Motor", procurementType: "PURCHASED" as const },
    ])
    .returning();
  AHU = ahu.id;
  FAN = fan.id;
  MOTOR = motor.id;

  const [frameStation, fanStation, finalStation] = await db
    .insert(stations)
    .values([{ name: "Frame Fab" }, { name: "Fan & Motor Assembly" }, { name: "Final Assembly" }])
    .returning();

  const [s1, s2, s3] = await db
    .insert(routingSteps)
    .values([
      { itemId: AHU, sequence: 1, name: "Build frame", stationId: frameStation.id, expectedMinutes: 90 },
      { itemId: AHU, sequence: 2, name: "Fit fan section", stationId: finalStation.id, expectedMinutes: 60 },
      { itemId: AHU, sequence: 3, name: "Run test", stationId: finalStation.id, expectedMinutes: 30 },
    ])
    .returning();

  const [fs1] = await db
    .insert(routingSteps)
    .values([
      { itemId: FAN, sequence: 1, name: "Assemble fan", stationId: fanStation.id, expectedMinutes: 45 },
    ])
    .returning();

  await db.insert(bomLines).values([
    { parentItemId: AHU, componentItemId: FAN, quantity: 1, consumedAtRoutingStepId: s2.id },
    { parentItemId: FAN, componentItemId: MOTOR, quantity: 1, consumedAtRoutingStepId: fs1.id },
  ]);

  const [order] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-1000", itemId: AHU, quantity: 1, status: "PLANNED" })
    .returning();

  await releaseWorkOrder(order.id, null);

  const parentTasks = await db
    .select()
    .from(workOrderTasks)
    .where(eq(workOrderTasks.workOrderId, order.id));
  frameOp = parentTasks.find((t) => t.routingStepId === s1.id)!.id;
  fitFanOp = parentTasks.find((t) => t.routingStepId === s2.id)!.id;
  testOp = parentTasks.find((t) => t.routingStepId === s3.id)!.id;

  const [child] = await db
    .select()
    .from(workOrders)
    .where(eq(workOrders.parentWorkOrderId, order.id));
  const [childTask] = await db
    .select()
    .from(workOrderTasks)
    .where(eq(workOrderTasks.workOrderId, child.id));
  fanOp = childTask.id;

  const [req] = await db
    .select()
    .from(materialRequirements)
    .where(
      and(eq(materialRequirements.operationId, fitFanOp), eq(materialRequirements.itemId, FAN))
    );
  fanRequirementId = req.id;
});

const markDone = (taskId: number) =>
  db.update(workOrderTasks).set({ status: "DONE" }).where(eq(workOrderTasks.id, taskId));

/** Get the fan section through production and inspection so it can be allocated. */
async function acceptFanUnits(n: number) {
  await reportProduction({ commandId: uid("prod"), operationId: fanOp, quantity: n });
  await inspectOutput({
    commandId: uid("insp"),
    operationId: fanOp,
    from: "pendingInspection",
    to: "accepted",
    quantity: n,
  });
}

// ===========================================================================
// Release produces real dependency records, not implied ones
// ===========================================================================

test("D1 — releasing an order writes the routing chain and the convergent edge", async () => {
  const deps = await db.select().from(operationDependencies);

  const chain = deps.filter((d) => d.type === "FULL_COMPLETION");
  assert.ok(
    chain.some((d) => d.operationId === fitFanOp && d.dependsOnOperationId === frameOp),
    "step 2 depends on step 1"
  );
  assert.ok(
    chain.some((d) => d.operationId === testOp && d.dependsOnOperationId === fitFanOp),
    "step 3 depends on step 2"
  );

  const convergent = deps.find(
    (d) => d.type === "REQUIRED_QUANTITY" && d.operationId === fitFanOp
  );
  assert.ok(convergent, "the consuming step has a quantity dependency");
  assert.equal(
    convergent.dependsOnOperationId,
    fanOp,
    "it points at the sub-assembly's own operation, not at a step of its own routing"
  );
  assert.equal(convergent.requiredQuantity, 1);
  assert.equal(convergent.requirementId, fanRequirementId, "scoped to the requirement, not the order");

  assert.ok(
    deps.some((d) => d.type === "QUALITY_ACCEPTANCE" && d.operationId === fitFanOp),
    "and a quality dependency beside it"
  );
});

test("D2 — re-releasing the same order does not duplicate dependencies", async () => {
  const before = (await db.select().from(operationDependencies)).length;
  const [order] = await db.select().from(workOrders).where(eq(workOrders.orderNumber, "WO-1000"));
  await releaseWorkOrder(order.id, null);
  const after = (await db.select().from(operationDependencies)).length;
  assert.equal(after, before, "idempotent");
});

// ===========================================================================
// The blockers say what is actually being waited on
// ===========================================================================

test("D3 — a step waiting on its predecessor names that step", async () => {
  const blockers = await blockersFor(fitFanOp);
  const dep = blockers.find((b) => b.label === "Earlier step");
  assert.ok(dep, "blocked by the earlier step");
  assert.match(dep.detail, /Build frame/, "names the step rather than saying 'not your turn'");
  assert.equal(dep.kind, "SEQUENCE", "a predecessor in the same routing is queueing, not a hold-up");
  assert.equal(dep.sourceOperationId, frameOp);
});

test("D4 — with the predecessor done, the sub-assembly is what remains", async () => {
  await markDone(frameOp);

  const blockers = await blockersFor(fitFanOp);
  assert.equal(
    blockers.filter((b) => b.label === "Earlier step").length,
    0,
    "predecessor no longer blocks"
  );

  const sub = blockers.find((b) => b.label === "Sub-assembly");
  assert.ok(sub, "still waiting on the fan section");
  assert.match(sub.detail, /Fan Section/, "names the part");
  assert.match(sub.detail, /Assemble fan/, "and the operation building it");
  assert.equal(sub.shortBy, 1);
  assert.equal(sub.sourceOperationId, fanOp);
});

test("D5 — allocating the sub-assembly clears the dependency", async () => {
  await markDone(frameOp);
  await acceptFanUnits(1);
  await allocateOutput({
    commandId: uid("alloc"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });

  const blockers = await blockersFor(fitFanOp);
  assert.equal(
    blockers.filter((b) => b.label === "Sub-assembly").length,
    0,
    "the fan section is committed to this requirement"
  );
});

test("D6 — the dependency stays satisfied once the allocation is consumed", async () => {
  // The rev-4 correction: installing relieves the allocation, so a rule reading
  // only allocatedOutstanding would block a step that had already fitted the part.
  await markDone(frameOp);
  await acceptFanUnits(1);
  await allocateOutput({
    commandId: uid("alloc"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });
  await issueOutputToParent({
    commandId: uid("issue"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });

  const blockers = await blockersFor(fitFanOp);
  assert.equal(
    blockers.filter((b) => b.label === "Sub-assembly").length,
    0,
    "installed material still fulfils the requirement"
  );
});

test("D7 — returning the sub-assembly to stores raises the shortage again", async () => {
  await markDone(frameOp);
  await acceptFanUnits(1);
  await allocateOutput({
    commandId: uid("alloc"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });
  await issueOutputToParent({
    commandId: uid("issue"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });
  await returnOutputFromParent({
    commandId: uid("ret"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });

  const blockers = await blockersFor(fitFanOp);
  const sub = blockers.find((b) => b.label === "Sub-assembly");
  assert.ok(sub, "a returned component no longer fulfils the requirement");
  assert.equal(sub.shortBy, 1);
});

// ===========================================================================
// Quality acceptance is a separate axis from quantity
// ===========================================================================

test("D8 — a quality hold blocks the parent even though the quantity exists", async () => {
  await markDone(frameOp);
  await acceptFanUnits(2);
  await allocateOutput({
    commandId: uid("alloc"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });

  // Quantity is satisfied at this point.
  assert.equal(
    (await blockersFor(fitFanOp)).filter((b) => b.label === "Sub-assembly").length,
    0
  );

  await holdOutput({
    commandId: uid("hold"),
    operationId: fanOp,
    quantity: 1,
    reason: "Bearing noise reported on the batch",
  });

  const blockers = await blockersFor(fitFanOp);
  const hold = blockers.find((b) => b.label === "Quality hold");
  assert.ok(hold, "the hold blocks the parent");
  assert.match(hold.detail, /Fan Section/);
});

test("D9 — releasing the hold clears the parent again", async () => {
  await markDone(frameOp);
  await acceptFanUnits(2);
  await allocateOutput({
    commandId: uid("alloc"),
    operationId: fanOp,
    requirementId: fanRequirementId,
    quantity: 1,
  });
  const held = { commandId: uid("hold"), operationId: fanOp, quantity: 1, reason: "check" };
  await holdOutput(held);
  await releaseOutputHold({ commandId: uid("rel"), operationId: fanOp, quantity: 1 });

  const blockers = await blockersFor(fitFanOp);
  assert.equal(blockers.length, 0, "nothing left to wait on");
});

test("D10 — replaying a hold command holds once", async () => {
  await acceptFanUnits(2);
  const cmd = { commandId: uid("hold"), operationId: fanOp, quantity: 1, reason: "check" };
  await holdOutput(cmd);
  await holdOutput(cmd);

  const blockers = await blockersFor(fitFanOp);
  assert.equal(blockers.filter((b) => b.label === "Quality hold").length, 1);

  // And a release of the same size must fully clear it — proving only one was held.
  await releaseOutputHold({ commandId: uid("rel"), operationId: fanOp, quantity: 1 });
  assert.equal(
    (await blockersFor(fitFanOp)).filter((b) => b.label === "Quality hold").length,
    0
  );
});

// ===========================================================================
// Material shortage is reported in the same shape
// ===========================================================================

test("D11 — a purchased shortage names the part and the shortfall", async () => {
  const blockers = await blockersFor(fanOp);
  const material = blockers.find((b) => b.kind === "MATERIAL");
  assert.ok(material, "the fan step cannot start without a motor");
  assert.match(material.detail, /5HP Motor/);
  assert.equal(material.shortBy, 1);
  assert.equal(material.itemSku, "BUY-MOTOR-5HP");
});

test("D12 — stocking the part clears the material blocker", async () => {
  await receiveStock({
    commandId: uid("recv"),
    itemId: MOTOR,
    locationId: STORES,
    quantity: 2,
  });

  const blockers = await blockersFor(fanOp);
  assert.equal(blockers.length, 0, "first step of the sub-assembly is ready");
});

// ===========================================================================
// The supervisor's question
// ===========================================================================

test("D13 — waitingOperations lists every stuck step with its reason", async () => {
  const waiting = await waitingOperations();

  const byName = new Map(waiting.map((w) => [w.operationName, w]));
  assert.ok(byName.has("Assemble fan"), "the fan step is waiting on a motor");
  assert.ok(byName.has("Fit fan section"), "final assembly is waiting too");

  assert.equal(
    byName.get("Assemble fan")!.blockers[0].kind,
    "MATERIAL",
    "and each one carries why"
  );
  assert.ok(
    byName.get("Fit fan section")!.blockers.some((b) => b.kind === "SEQUENCE"),
    "its predecessor is reported as sequence, not as a real hold-up"
  );
  assert.ok(
    byName.get("Fit fan section")!.blockers.some((b) => b.kind === "DEPENDENCY"),
    "final assembly is waiting on work, not stock"
  );
});

test("D14 — a step with nothing in its way is not listed as waiting", async () => {
  await receiveStock({
    commandId: uid("recv"),
    itemId: MOTOR,
    locationId: STORES,
    quantity: 2,
  });

  const waiting = await waitingOperations();
  assert.equal(
    waiting.some((w) => w.operationName === "Assemble fan"),
    false,
    "it has its motor and no predecessor"
  );
  assert.ok(
    waiting.some((w) => w.operationName === "Build frame") === false,
    "the first step of the parent was never blocked"
  );
});
