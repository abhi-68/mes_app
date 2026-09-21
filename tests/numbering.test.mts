import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "../src/db/index.ts";
import { items, workOrders } from "../src/db/schema.ts";
import { resetDatabase } from "./helpers.ts";
import {
  dateStamp, jobNumberFor, nextSuffix, nextWorkOrderNumber,
} from "../src/lib/numbering.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

after(async () => {
  await pool.end();
});

let itemId = 0;
beforeEach(async () => {
  await resetDatabase();
  const [item] = await db
    .insert(items)
    .values({ sku: "FG-1", name: "Air Handling Unit", procurementType: "MANUFACTURED" })
    .returning();
  itemId = item.id;
});

const raise = async (orderNumber: string) => {
  await db.insert(workOrders).values({ orderNumber, itemId, quantity: 1, status: "PLANNED" });
};

test("the stamp is six digits of year, month and day", () => {
  assert.match(dateStamp(new Date(2026, 8, 20)), /^260920$/);
  assert.match(dateStamp(new Date(2026, 0, 1)), /^260101$/);
  assert.equal(dateStamp(new Date(2099, 11, 31)), "991231");
});

test("suffixes count from one and ignore other days and other prefixes", () => {
  const head = "WO-260920-";
  assert.equal(nextSuffix(head, []), 1);
  assert.equal(nextSuffix(head, ["WO-260920-001", "WO-260920-002"]), 3);
  assert.equal(nextSuffix(head, ["WO-260919-009"]), 1, "yesterday does not carry over");
  assert.equal(nextSuffix(head, ["DN-260920-004"]), 1, "another document type is separate");
});

test("a sub-assembly suffix does not consume a number of its own", () => {
  // Children are numbered WO-260920-001-01, and must not push the parent series to 2.
  const head = "WO-260920-";
  assert.equal(nextSuffix(head, ["WO-260920-001", "WO-260920-001-01", "WO-260920-001-02"]), 2);
});

test("the first order is ORD-0001", async () => {
  assert.equal(await nextWorkOrderNumber(), "ORD-0001");
});

test("orders run on one counter that does not reset", async () => {
  // Deliberately not dated: a counter that restarts each day makes "order one"
  // ambiguous the moment somebody says it out loud a day later.
  await raise(await nextWorkOrderNumber());
  assert.equal(await nextWorkOrderNumber(), "ORD-0002");
  await raise("ORD-0002");
  assert.equal(await nextWorkOrderNumber(), "ORD-0003");
});

test("a sub-assembly is numbered from its parent and takes no number of its own", async () => {
  await raise("ORD-0001");
  await raise("ORD-0001-01");
  await raise("ORD-0001-02");
  assert.equal(await nextWorkOrderNumber(), "ORD-0002", "children do not advance the series");
});

test("numbers in another format do not break the series", async () => {
  await raise("WO-1001");
  await raise("LEGACY-7");
  assert.equal(await nextWorkOrderNumber(), "ORD-0001");
});

test("the series continues past the highest number, not the row count", async () => {
  // Deleting order 2 of 3 must not hand ORD-0003 out twice.
  await raise("ORD-0001");
  await raise("ORD-0009");
  assert.equal(await nextWorkOrderNumber(), "ORD-0010");
});

// --- job numbers ---------------------------------------------------------

test("a job is its order and the station it runs at", () => {
  assert.equal(jobNumberFor("ORD-0001", 20, []), "ORD-0001-20");
  assert.equal(jobNumberFor("ORD-0042", 5, []), "ORD-0042-05");
});

test("a routing that visits one station twice still gets two distinct numbers", () => {
  // Laser cut, bend, then back to the laser to mark. A number that identifies
  // two jobs identifies neither.
  const taken: string[] = [];
  const a = jobNumberFor("ORD-0001", 10, taken);
  taken.push(a);
  const b = jobNumberFor("ORD-0001", 10, taken);
  taken.push(b);
  const c = jobNumberFor("ORD-0001", 10, taken);
  assert.equal(a, "ORD-0001-10");
  assert.equal(b, "ORD-0001-10-2");
  assert.equal(c, "ORD-0001-10-3");
  assert.equal(new Set([a, b, c]).size, 3);
});

test("a step with no station is named by its order alone", () => {
  assert.equal(jobNumberFor("ORD-0001", null, []), "ORD-0001");
});

test("two orders raised at the same instant never take the same number", async () => {
  // The whole reason the allocation sits under an advisory lock. Each transaction
  // allocates and inserts, exactly as createWorkOrder does.
  const allocate = () =>
    db.transaction(async (tx) => {
      const n = await nextWorkOrderNumber({ tx });
      await tx.insert(workOrders).values({
        orderNumber: n,
        itemId,
        quantity: 1,
        status: "PLANNED",
      });
      return n;
    });

  const issued = await Promise.all([allocate(), allocate(), allocate(), allocate(), allocate()]);

  assert.equal(new Set(issued).size, 5, `expected 5 distinct numbers, got ${issued.join(", ")}`);
  const rows = await db.select({ n: workOrders.orderNumber }).from(workOrders);
  assert.equal(rows.length, 5);
  assert.deepEqual(
    [...issued].sort(),
    [1, 2, 3, 4, 5].map((i) => `ORD-${String(i).padStart(4, "0")}`)
  );
});
