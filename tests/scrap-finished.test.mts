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
  routingSteps,
  materialRequirements,
  operationDependencies,
  dispositionRecords,
} from "../src/db/schema";
import { CommandError } from "../src/lib/inventory";
import {
  reportProduction,
  inspectOutput,
  allocateOutput,
  issueOutputToParent,
  deallocateOutput,
  scrapFinishedOutput,
  outputStateFor,
  satisfiedQuantityFor,
} from "../src/lib/outputs";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

let CHILD_OP = 0;
let REQ = 0;

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();

  const [panel] = await db
    .insert(items)
    .values({ sku: "SUB-PANEL-01", name: "Insulated Panel", procurementType: "MANUFACTURED" })
    .returning();
  const [unit] = await db
    .insert(items)
    .values({ sku: "AHU-01", name: "Air Handler", procurementType: "MANUFACTURED" })
    .returning();

  const [station] = await db.insert(stations).values({ name: "Panel Fab" }).returning();
  const [step] = await db
    .insert(routingSteps)
    .values({ itemId: panel.id, sequence: 1, name: "Close double-wall", stationId: station.id })
    .returning();

  const [parentOrder] = await db
    .insert(workOrders)
    .values({ orderNumber: "WO-PARENT", itemId: unit.id, quantity: 1, status: "RELEASED" })
    .returning();
  const [parentTask] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: parentOrder.id,
      routingStepId: step.id,
      sequence: 1,
      name: "Mount panels",
      stationId: station.id,
    })
    .returning();

  const [childOrder] = await db
    .insert(workOrders)
    .values({
      orderNumber: "WO-CHILD",
      itemId: panel.id,
      quantity: 4,
      status: "RELEASED",
      parentWorkOrderId: parentOrder.id,
    })
    .returning();
  const [childTask] = await db
    .insert(workOrderTasks)
    .values({
      workOrderId: childOrder.id,
      routingStepId: step.id,
      sequence: 1,
      name: "Close double-wall",
      stationId: station.id,
    })
    .returning();

  const [req] = await db
    .insert(materialRequirements)
    .values({ operationId: parentTask.id, itemId: panel.id, requiredQty: 4 })
    .returning();

  await db.insert(operationDependencies).values({
    operationId: parentTask.id,
    dependsOnOperationId: childTask.id,
    type: "REQUIRED_QUANTITY",
    requirementId: req.id,
    requiredQuantity: 4,
  });

  CHILD_OP = childTask.id;
  REQ = req.id;
});

/** The normal path: made, accepted on completion, earmarked for the parent. */
async function deliveredToParent(quantity: number) {
  await reportProduction({ commandId: uid("p"), operationId: CHILD_OP, quantity });
  await inspectOutput({
    commandId: uid("i"),
    operationId: CHILD_OP,
    from: "pendingInspection",
    to: "accepted",
    quantity,
  });
  await allocateOutput({
    commandId: uid("a"),
    operationId: CHILD_OP,
    requirementId: REQ,
    quantity,
  });
}

test("work found wrong before anyone inspects it is written off", async () => {
  await reportProduction({ commandId: uid("p"), operationId: CHILD_OP, quantity: 4 });

  await scrapFinishedOutput({
    commandId: uid("s"),
    operationId: CHILD_OP,
    quantity: 2,
    reason: "Weld porosity",
  });

  const s = await outputStateFor(CHILD_OP);
  assert.equal(s.scrapped, 2);
  assert.equal(s.pendingInspection, 2, "the good two still await judgement");
  assert.equal(s.produced, 4, "history does not change — four were made");
});

test("work already earmarked for the parent is released before it is scrapped", async () => {
  await deliveredToParent(4);
  assert.equal(await satisfiedQuantityFor(REQ), 4, "parent is counting on four");

  await scrapFinishedOutput({
    commandId: uid("s"),
    operationId: CHILD_OP,
    quantity: 3,
    reason: "Wrong gasket channel",
  });

  const s = await outputStateFor(CHILD_OP);
  assert.equal(s.scrapped, 3);
  assert.equal(s.accepted, 1, "one good one left");
  assert.equal(s.allocatedOutstanding, 1, "the parent is promised only what exists");
  assert.equal(
    await satisfiedQuantityFor(REQ),
    1,
    "the parent stops counting on parts that are in the skip"
  );
});

test("the least committed units go first, so nothing is needlessly unpicked", async () => {
  await deliveredToParent(2);
  // Two more made afterwards that nobody has looked at yet.
  await reportProduction({ commandId: uid("p2"), operationId: CHILD_OP, quantity: 2 });

  await scrapFinishedOutput({
    commandId: uid("s"),
    operationId: CHILD_OP,
    quantity: 2,
    reason: "Dimension out",
  });

  const s = await outputStateFor(CHILD_OP);
  assert.equal(s.pendingInspection, 0, "the uninspected two were taken");
  assert.equal(s.accepted, 2, "the accepted ones were left alone");
  assert.equal(s.allocatedOutstanding, 2, "the parent's earmark was never disturbed");
});

test("a part already fitted into the next assembly is refused, and says why", async () => {
  await deliveredToParent(4);
  await issueOutputToParent({
    commandId: uid("inst"),
    operationId: CHILD_OP,
    requirementId: REQ,
    quantity: 4,
  });

  await assert.rejects(
    () =>
      scrapFinishedOutput({
        commandId: uid("s"),
        operationId: CHILD_OP,
        quantity: 1,
        reason: "Found cracked",
      }),
    (e: unknown) =>
      e instanceof CommandError &&
      e.code === "STATE_GUARD" &&
      /already fitted/.test(e.message) &&
      /come back out/.test(e.message)
  );

  const s = await outputStateFor(CHILD_OP);
  assert.equal(s.scrapped, 0, "nothing was written off");
  assert.equal(s.issuedToParentOutstanding, 4, "the installation still stands");
});

test("only the units that are not fitted can be written off", async () => {
  await deliveredToParent(4);
  await issueOutputToParent({
    commandId: uid("inst"),
    operationId: CHILD_OP,
    requirementId: REQ,
    quantity: 3,
  });

  // One accepted unit is still loose, so exactly one can go.
  await scrapFinishedOutput({
    commandId: uid("s"),
    operationId: CHILD_OP,
    quantity: 1,
    reason: "Skin dented in handling",
  });

  const s = await outputStateFor(CHILD_OP);
  assert.equal(s.scrapped, 1);
  assert.equal(s.issuedToParentOutstanding, 3, "the fitted three are untouched");

  await assert.rejects(
    () =>
      scrapFinishedOutput({
        commandId: uid("s2"),
        operationId: CHILD_OP,
        quantity: 1,
        reason: "and another",
      }),
    (e: unknown) => e instanceof CommandError && e.code === "STATE_GUARD"
  );
});

test("writing off the same mistake twice records it once", async () => {
  await deliveredToParent(4);
  const payload = {
    commandId: uid("s"),
    operationId: CHILD_OP,
    quantity: 2,
    reason: "Weld porosity",
  };

  await scrapFinishedOutput(payload);
  await scrapFinishedOutput(payload);

  const s = await outputStateFor(CHILD_OP);
  assert.equal(s.scrapped, 2, "the retry replayed rather than scrapping four");
  assert.equal(s.accepted, 2);
});

test("a write-off leaves a reason on the record, not a bare number", async () => {
  await reportProduction({ commandId: uid("p"), operationId: CHILD_OP, quantity: 2 });
  await scrapFinishedOutput({
    commandId: uid("s"),
    operationId: CHILD_OP,
    quantity: 1,
    reason: "Wrong gasket channel",
  });

  const [row] = await db
    .select()
    .from(dispositionRecords)
    .where(eq(dispositionRecords.kind, "SCRAP"));
  assert.equal(row.reason, "Wrong gasket channel");
  assert.equal(row.quantity, 1);
});

test("releasing an earmark nothing holds is refused", async () => {
  await reportProduction({ commandId: uid("p"), operationId: CHILD_OP, quantity: 1 });

  await assert.rejects(
    () =>
      deallocateOutput({
        commandId: uid("d"),
        operationId: CHILD_OP,
        requirementId: REQ,
        quantity: 1,
      }),
    (e: unknown) => e instanceof CommandError && e.code === "STATE_GUARD"
  );
});

test("scrapping more than was ever made is refused", async () => {
  await reportProduction({ commandId: uid("p"), operationId: CHILD_OP, quantity: 2 });

  await assert.rejects(
    () =>
      scrapFinishedOutput({
        commandId: uid("s"),
        operationId: CHILD_OP,
        quantity: 5,
        reason: "all of them",
      }),
    (e: unknown) => e instanceof CommandError && e.code === "STATE_GUARD"
  );
  assert.equal((await outputStateFor(CHILD_OP)).scrapped, 0);
});
