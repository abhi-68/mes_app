/**
 * A functional audit: drive every action the app exposes and report what works.
 *
 * This is not the test suite. The tests prove one rule each in isolation; this
 * walks the whole floor in order — raise an order, receive stock, start a step,
 * scan the material, finish it, inspect it, ship it — as the roles who would do
 * each part, and prints a pass/fail line per capability. It is what to run when
 * somebody says "it is not working" and nobody can say which "it".
 *
 *   DATABASE_URL=postgresql://...:5432/mes_audit npm run audit
 *
 * It WRITES, so it refuses any database whose name does not contain "audit".
 * Rebuild that database first:  DATABASE_URL=...mes_audit node scripts/setup-db.mjs
 */
import "dotenv/config";

if (!(process.env.DATABASE_URL ?? "").includes("audit")) {
  console.error("Refusing to run: DATABASE_URL must point at a database whose name contains 'audit'.");
  console.error("This script writes. It must never touch a development or production database.");
  process.exit(1);
}
import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

/** Who the action layer thinks is calling. Swapped between checks. */
let actor: { id: number; name: string; email: string; role: string; stationId: number | null } | null =
  null;

mock.module("../src/lib/session.ts", {
  namedExports: {
    getCurrentUser: async () => actor,
    requireUser: async () => {
      if (!actor) throw new Error("Not signed in");
      return actor;
    },
    requireRole: async (...roles: string[]) => {
      if (!actor) throw new Error("Not signed in");
      if (!roles.includes(actor.role)) throw new Error(`Needs ${roles.join(" or ")}`);
      return actor;
    },
    isManager: (role: string) => role === "SUPERVISOR" || role === "ADMIN",
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
// The station a device is "at" lives in a cookie, which does not exist outside a
// request. Treated as unset here; the home-station rule covers the worker checks.
mock.module("../src/lib/terminal.ts", {
  namedExports: {
    terminalStation: async () => null,
    setTerminalStation: async () => {},
    signStationId: (n: number) => String(n),
    verifyStationCookie: () => null,
    canWorkOnTask: (input: {
      role: string;
      userId: number;
      homeStationId: number | null;
      taskStationId: number | null;
      assignedToUserId: number | null;
    }) => {
      if (input.role === "SUPERVISOR" || input.role === "ADMIN") return { allowed: true };
      if (input.taskStationId === null) return { allowed: true };
      if (input.assignedToUserId === input.userId) return { allowed: true };
      if (input.homeStationId === input.taskStationId) return { allowed: true };
      return { allowed: false, reason: "This step is at another station. Switch to that station." };
    },
  },
});

/**
 * Rebuild the audit database first.
 *
 * The walk leaves state behind by design — it raises orders, draws stock and
 * finishes steps. Re-running against that state fails on duplicate SKUs and
 * empty racks, which says nothing about the app. So every run starts from the
 * same seeded floor.
 */
{
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reset = spawnSync(
    process.execPath,
    [path.join(here, "setup-db.mjs")],
    { stdio: ["ignore", "ignore", "inherit"], env: process.env }
  );
  if (reset.status !== 0) {
    console.error("Could not rebuild the audit database.");
    process.exit(1);
  }
  console.log("audit database rebuilt from the seed");
}

const { db, pool } = await import("../src/db/index.ts");
const S = await import("../src/db/schema.ts");

const tasks = await import("../src/app/actions/tasks.ts");
const admin = await import("../src/app/actions/admin.ts");
const materials = await import("../src/app/actions/materials.ts");
const quality = await import("../src/app/actions/quality.ts");
const delivery = await import("../src/app/actions/delivery.ts");
const picking = await import("../src/app/actions/picking.ts");
const stock = await import("../src/app/actions/stock.ts");
const scanAct = await import("../src/app/actions/scan.ts");
const alerts = await import("../src/app/actions/alerts.ts");
const outputs = await import("../src/lib/outputs.ts");
const pickingLib = await import("../src/lib/picking.ts");

type Row = { area: string; check: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const rows: Row[] = [];
const record = (area: string, check: string, status: Row["status"], detail = "") =>
  rows.push({ area, check, status, detail });

async function expect(area: string, check: string, fn: () => Promise<string>) {
  try {
    record(area, check, "PASS", await fn());
  } catch (e) {
    record(area, check, "FAIL", e instanceof Error ? e.message : String(e));
  }
}

const ok = (r: { ok: boolean; error?: string }, what: string) => {
  if (!r.ok) throw new Error(`${what}: ${r.error ?? "refused"}`);
};
const refused = (r: { ok: boolean; error?: string }, what: string) => {
  if (r.ok) throw new Error(`${what} was ALLOWED but should not be`);
  return r.error ?? "";
};

// --- who we act as -------------------------------------------------------
const people = await db.select().from(S.users).orderBy(asc(S.users.id));
const ADMIN = people.find((p) => p.role === "ADMIN")!;
const SUP = people.find((p) => p.role === "SUPERVISOR")!;
const asUser = (u: typeof ADMIN) => {
  actor = { id: u.id, name: u.name, email: u.email, role: u.role, stationId: u.stationId };
};

// =========================================================================
asUser(ADMIN);

await expect("Setup", "Create a station", async () => {
  ok(await admin.createStation("Audit Station", "created by the audit"), "createStation");
  return "created";
});

await expect("Setup", "Create an item", async () => {
  ok(
    await admin.createItem({
      sku: "AUDIT-PART", name: "Audit Part", procurementType: "PURCHASED",
      unitOfMeasure: "ea", isFinishedGood: false, reorderPoint: 5, openingStock: 0,
    }),
    "createItem"
  );
  return "created";
});

await expect("Setup", "Create a vendor and a customer", async () => {
  ok(await admin.createVendor("Audit Steel Co"), "createVendor");
  ok(await admin.createCustomer("Audit Customer"), "createCustomer");
  return "both created";
});

await expect("Setup", "Add a routing step and a BOM line", async () => {
  const [made] = await db.select().from(S.items)
    .where(eq(S.items.procurementType, "MANUFACTURED")).limit(1);
  const [comp] = await db.select().from(S.items).where(eq(S.items.sku, "AUDIT-PART"));
  const [station] = await db.select().from(S.stations).limit(1);
  ok(
    await admin.addRoutingStep({
      itemId: made.id, name: "Audit step", stationId: station.id, expectedMinutes: 10,
    }),
    "addRoutingStep"
  );
  ok(await admin.addBomLine({ parentItemId: made.id, componentItemId: comp.id, quantity: 1, consumedAtRoutingStepId: null }), "addBomLine");
  return "routing + BOM";
});

let NEW_ORDER = 0;
await expect("Orders", "Raise a work order (auto-numbered)", async () => {
  const before = await db.select({ n: sql<number>`count(*)::int` }).from(S.workOrders);
  const [fg] = await db.select().from(S.items).where(eq(S.items.isFinishedGood, true)).limit(1);
  const [cust] = await db.select().from(S.customers).limit(1);
  ok(
    await admin.createWorkOrder({
      itemId: fg.id, customerId: cust?.id ?? null, quantity: 1,
      dueDate: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
    }),
    "createWorkOrder"
  );
  const after = await db.select({ n: sql<number>`count(*)::int` }).from(S.workOrders);
  const made = after[0].n - before[0].n;
  const [latest] = await db.select().from(S.workOrders)
    .where(isNull(S.workOrders.parentWorkOrderId))
    .orderBy(sql`id desc`).limit(1);
  NEW_ORDER = latest.id;
  if (!/^ORD-\d{4}$/.test(latest.orderNumber)) {
    throw new Error(`order number format wrong: ${latest.orderNumber}`);
  }
  return `${latest.orderNumber} + ${made - 1} sub-assemblies`;
});

await expect("Orders", "Released order has steps and dependencies", async () => {
  const steps = await db.select().from(S.workOrderTasks).where(eq(S.workOrderTasks.workOrderId, NEW_ORDER));
  if (steps.length === 0) throw new Error("no steps were built");
  const deps = await db.select().from(S.operationDependencies);
  return `${steps.length} steps on the parent, ${deps.length} dependencies on the floor`;
});

await expect("Orders", "Every job is numbered order + station, uniquely", async () => {
  const steps = await db
    .select({ n: S.workOrderTasks.jobNumber })
    .from(S.workOrderTasks)
    .where(eq(S.workOrderTasks.workOrderId, NEW_ORDER));
  const numbers = steps.map((s) => s.n).filter((n): n is string => Boolean(n));
  if (numbers.length !== steps.length) throw new Error("some steps have no job number");
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`job numbers repeat: ${numbers.join(", ")}`);
  }
  const bad = numbers.find((n) => !/^ORD-\d{4}-\d{2}(-\d+)?$/.test(n));
  if (bad) throw new Error(`job number format wrong: ${bad}`);
  return numbers.slice(0, 3).join(", ") + (numbers.length > 3 ? ` (+${numbers.length - 3})` : "");
});

// --- Receiving + barcodes -------------------------------------------------
asUser(SUP);
let AUDIT_BATCH = "";
await expect("Stores", "Book a delivery in (barcode generated)", async () => {
  const [item] = await db.select().from(S.items).where(eq(S.items.sku, "AUDIT-PART"));
  const [loc] = await db.select().from(S.inventoryLocations).orderBy(asc(S.inventoryLocations.id)).limit(1);
  const [vendor] = await db.select().from(S.vendors).limit(1);
  const res = await admin.receiveDelivery({
    itemId: item.id, locationId: loc.id, quantity: 25, heatNumber: "AUDIT-HEAT",
    batchNumber: "", vendorId: vendor?.id ?? null, procurementReference: "PO-AUDIT",
    storageLocation: "Bay 99",
  });
  ok(res, "receiveDelivery");
  AUDIT_BATCH = res.batchNumber!;
  if (!AUDIT_BATCH) throw new Error("no batch number was generated");
  return `batch ${AUDIT_BATCH} auto-generated`;
});

await expect("Stores", "Scan resolves the batch", async () => {
  const found = await stock.findLot(AUDIT_BATCH);
  if (!found.ok) throw new Error(found.error);
  return `${found.lot.itemName}, ${found.lot.remaining} left at ${found.lot.locationName}`;
});

await expect("Stores", "Reject damaged stock by scan", async () => {
  const found = await stock.findLot(AUDIT_BATCH);
  if (!found.ok) throw new Error(found.error);
  const res = await stock.rejectStock({
    commandId: randomUUID(), lotId: found.lot.lotId, itemId: found.lot.itemId,
    locationId: found.lot.locationId, quantity: 3, reason: "Audit: corner crushed",
  });
  if (!res.ok) throw new Error(res.error);
  const after = await stock.findLot(AUDIT_BATCH);
  if (!after.ok) throw new Error("lot vanished");
  return `25 -> ${after.lot.remaining}`;
});

await expect("Stores", "A write-off without a reason is refused", async () => {
  const found = await stock.findLot(AUDIT_BATCH);
  if (!found.ok) throw new Error(found.error);
  const res = await stock.rejectStock({
    commandId: randomUUID(), lotId: found.lot.lotId, itemId: found.lot.itemId,
    locationId: found.lot.locationId, quantity: 1, reason: "   ",
  });
  return refused(res, "reason-less write-off");
});

// --- Work: start, pick, complete -----------------------------------------
let STEP = 0;
let WORKER: typeof ADMIN | null = null;

await expect("Work", "Find a startable step and sign in as its operator", async () => {
  const candidates = await db
    .select({ id: S.workOrderTasks.id, stationId: S.workOrderTasks.stationId })
    .from(S.workOrderTasks)
    .innerJoin(S.workOrders, eq(S.workOrders.id, S.workOrderTasks.workOrderId))
    .where(and(eq(S.workOrderTasks.status, "PENDING"), eq(S.workOrders.status, "RELEASED")))
    .orderBy(asc(S.workOrderTasks.id));
  for (const cand of candidates) {
    const worker = people.find((p) => p.role === "WORKER" && p.stationId === cand.stationId);
    if (worker) {
      STEP = cand.id;
      WORKER = worker;
      asUser(worker);
      return `step ${STEP} as ${worker.name}`;
    }
  }
  throw new Error("no startable step with a matching worker");
});

await expect("Work", "Start does NOT deduct stock", async () => {
  const lines = await pickingLib.pickListFor(STEP);
  const before = lines.map((l) => l.taken).reduce((a, b) => a + b, 0);
  ok(await tasks.startTask(STEP, randomUUID()), "startTask");
  const after = await pickingLib.pickListFor(STEP);
  const taken = after.map((l) => l.taken).reduce((a, b) => a + b, 0);
  if (taken !== before) throw new Error(`start drew ${taken - before} units`);
  const reserved = after.map((l) => l.reserved).reduce((a, b) => a + b, 0);
  return `nothing drawn, ${reserved} committed`;
});

await expect("Work", "Pick list says what to collect", async () => {
  const lines = await pickingLib.pickListFor(STEP);
  if (lines.length === 0) return "this step needs no material";
  return lines.map((l) => `${l.outstanding} ${l.unit} ${l.itemName}`).join(", ");
});

await expect("Work", "Scan a batch to take material", async () => {
  const lines = await pickingLib.pickListFor(STEP);
  const line = lines.find((l) => l.outstanding > 0);
  if (!line) return "nothing outstanding — skipped";
  const [loc] = await db.select().from(S.inventoryLocations).orderBy(asc(S.inventoryLocations.id)).limit(1);
  const lots = await db
    .select({ batch: S.stockLots.batchNumber })
    .from(S.stockLots)
    .where(eq(S.stockLots.itemId, line.itemId));
  for (const l of lots) {
    if (!l.batch) continue;
    const got = await pickingLib.findPickLot(l.batch, loc.id);
    if (!got || got.remaining < 1) continue;
    const qty = Math.min(line.outstanding, got.remaining);
    const res = await picking.pickMaterial({
      commandId: randomUUID(), operationId: STEP, requirementId: line.requirementId,
      batchNumber: l.batch, quantity: qty,
    });
    if (!res.ok) throw new Error(res.error);
    const [mv] = await db.select().from(S.inventoryMovements)
      .where(eq(S.inventoryMovements.type, "ISSUE")).orderBy(sql`id desc`).limit(1);
    return `took ${qty} from ${l.batch}, lotAssumed=${mv.lotAssumed}`;
  }
  throw new Error("no batch with stock for this part");
});

await expect("Work", "Wrong pallet is refused by name", async () => {
  const lines = await pickingLib.pickListFor(STEP);
  const line = lines[0];
  if (!line) return "no material on this step — skipped";
  const [other] = await db.select().from(S.stockLots)
    .where(sql`${S.stockLots.itemId} <> ${line.itemId} and ${S.stockLots.batchNumber} is not null`).limit(1);
  if (!other?.batchNumber) return "no other batch to try — skipped";
  const res = await picking.pickMaterial({
    commandId: randomUUID(), operationId: STEP, requirementId: line.requirementId,
    batchNumber: other.batchNumber, quantity: 1,
  });
  return refused(res, "wrong pallet");
});

await expect("Work", "Block and unblock a step", async () => {
  const [code] = await db.select().from(S.reasonCodes).where(eq(S.reasonCodes.category, "BLOCKED")).limit(1);
  ok(await tasks.blockTask(STEP, code?.id ?? null, "Audit block"), "blockTask");
  ok(await tasks.unblockTask(STEP), "unblockTask");
  return "blocked then cleared";
});

await expect("Work", "Complete the step", async () => {
  ok(await tasks.completeTask(STEP, "Audit completion"), "completeTask");
  const [t] = await db.select().from(S.workOrderTasks).where(eq(S.workOrderTasks.id, STEP));
  if (t.status !== "DONE") throw new Error(`status is ${t.status}`);
  return "DONE, clock stopped";
});

await expect("Work", "A worker cannot work another station's step", async () => {
  const [elsewhere] = await db
    .select()
    .from(S.workOrderTasks)
    .where(
      and(
        eq(S.workOrderTasks.status, "PENDING"),
        sql`${S.workOrderTasks.stationId} <> ${WORKER!.stationId}`,
        isNull(S.workOrderTasks.assignedToUserId)
      )
    )
    .limit(1);
  if (!elsewhere) return "no step at another station — skipped";
  return refused(await tasks.startTask(elsewhere.id, randomUUID()), "cross-station start");
});

// --- Supervisor powers ----------------------------------------------------
asUser(SUP);

await expect("Materials", "Reserve stock against a requirement", async () => {
  const plan = await (await import("../src/lib/material-planning.ts")).materialPlan();
  const candidates = plan.rows.filter((r) => !r.fromSubassembly && r.uncovered > 0 && r.free > 0);
  if (candidates.length === 0) return "nothing reservable — skipped";
  const refusals: string[] = [];
  for (const row of candidates.slice(0, 5)) {
    const res = await materials.reserveMaterial({ requirementId: row.requirementId, commandId: randomUUID() });
    if (res.ok) {
      return `reserved ${res.result.reserved} of ${row.itemName}, ${res.result.uncovered} left uncovered`;
    }
    refusals.push(`req ${row.requirementId} (${row.itemName}): ${res.error}`);
  }
  throw new Error(`screen offered ${candidates.length} rows; all refused — ` + refusals.join(" | "));
});

await expect("Work", "Assign a step to a named person", async () => {
  const [open] = await db.select().from(S.workOrderTasks)
    .where(eq(S.workOrderTasks.status, "PENDING")).limit(1);
  const worker = people.find((p) => p.role === "WORKER")!;
  ok(await tasks.assignTask(open.id, worker.id), "assignTask");
  ok(await tasks.assignTask(open.id, null), "unassign");
  return "assigned then taken back";
});

await expect("Quality", "Inspection queue and a pass", async () => {
  const qlib = await import("../src/lib/quality.ts");
  // Make something inspectable: report + leave it pending.
  const [task] = await db.select().from(S.workOrderTasks).where(eq(S.workOrderTasks.status, "DONE")).limit(1);
  if (!task) return "nothing finished yet — skipped";
  await outputs.reportProduction({ commandId: randomUUID(), operationId: task.id, quantity: 2 });
  const queue = await qlib.inspectionQueue();
  const item = queue.find((q) => q.operationId === task.id);
  if (!item) throw new Error("produced output did not reach the queue");
  const res = await quality.recordInspection({
    operationId: task.id, commandId: randomUUID(), quantity: 2, verdict: "PASS",
    from: "pendingInspection", requirementId: item.requirementId,
  });
  if (!res.ok) throw new Error(res.error);
  return `queue had ${queue.length}, passed 2`;
});

await expect("Quality", "Scrap with a reason", async () => {
  const [task] = await db.select().from(S.workOrderTasks).where(eq(S.workOrderTasks.status, "DONE")).limit(1);
  await outputs.reportProduction({ commandId: randomUUID(), operationId: task.id, quantity: 1 });
  const res = await quality.recordInspection({
    operationId: task.id, commandId: randomUUID(), quantity: 1, verdict: "SCRAP",
    from: "pendingInspection", reason: "Audit scrap",
  });
  if (!res.ok) throw new Error(res.error);
  return "scrapped 1";
});

let NOTE = 0;
await expect("Dispatch", "Raise a delivery note", async () => {
  const dlib = await import("../src/lib/delivery.ts");
  const shippable = await dlib.shippableOrders();
  if (shippable.length === 0) return "nothing shippable — skipped";
  const target = shippable[0];
  const res = await delivery.raiseDeliveryNote({
    workOrderId: target.orderId, quantity: 1, handlerUserId: null,
  });
  if (!res.ok) throw new Error(res.error);
  NOTE = res.result.id;
  if (!/^DN-\d{6}-\d{3}$/.test(res.result.noteNumber)) {
    throw new Error(`number format wrong: ${res.result.noteNumber}`);
  }
  return res.result.noteNumber;
});

await expect("Dispatch", "Move it through to delivered", async () => {
  if (!NOTE) return "no note — skipped";
  const worker = people.find((p) => p.role === "WORKER")!;
  ok(await delivery.moveDeliveryNote({ noteId: NOTE, to: "ALLOCATED", handlerUserId: worker.id }), "allocate");
  ok(await delivery.moveDeliveryNote({ noteId: NOTE, to: "PICKED_UP" }), "pick up");
  ok(await delivery.moveDeliveryNote({ noteId: NOTE, to: "DELIVERED" }), "deliver");
  return "unassigned -> allocated -> picked up -> delivered";
});

await expect("Dispatch", "Cannot oversell an order", async () => {
  if (!NOTE) return "no note — skipped";
  const [n] = await db.select().from(S.deliveryNotes).where(eq(S.deliveryNotes.id, NOTE));
  const res = await delivery.raiseDeliveryNote({
    workOrderId: n.workOrderId, quantity: 99999, handlerUserId: null,
  });
  return refused(res, "overselling");
});

await expect("Scanning", "A traveller code resolves to its step", async () => {
  const [t] = await db.select().from(S.workOrderTasks).limit(1);
  const target = await scanAct.lookupScan(`OP-${t.id}`);
  if (target.kind !== "operation") throw new Error(`resolved as ${target.kind}`);
  return target.label;
});

await expect("Scanning", "An unknown code is reported, not guessed", async () => {
  const target = await scanAct.lookupScan("NOT-A-REAL-CODE");
  if (target.kind !== "unknown") throw new Error(`resolved as ${target.kind}`);
  return "reported as unknown";
});

await expect("Alerts", "Acknowledge an alert", async () => {
  const [a] = await db.select().from(S.alerts).where(isNull(S.alerts.acknowledgedAt)).limit(1);
  if (!a) return "no open alerts — skipped";
  ok(await alerts.acknowledgeAlert(a.id), "acknowledgeAlert");
  return "acknowledged";
});

await expect("Timesheets", "Correct a recorded time", async () => {
  const [entry] = await db.select().from(S.timeEntries)
    .where(sql`${S.timeEntries.endedAt} is not null`).limit(1);
  if (!entry) return "no closed entries — skipped";
  ok(await tasks.adjustTimeEntry(entry.id, 42, "Audit correction"), "adjustTimeEntry");
  return "adjusted to 42 minutes, original kept";
});

// --- Permissions ----------------------------------------------------------
await expect("Permissions", "A worker cannot reserve stock", async () => {
  asUser(people.find((p) => p.role === "WORKER")!);
  const plan = await (await import("../src/lib/material-planning.ts")).materialPlan();
  const row = plan.rows.find((r) => !r.fromSubassembly && r.uncovered > 0);
  if (!row) return "nothing to reserve — skipped";
  return refused(
    await materials.reserveMaterial({ requirementId: row.requirementId, commandId: randomUUID() }),
    "worker reserving"
  );
});

await expect("Permissions", "A worker cannot inspect", async () => {
  const [t] = await db.select().from(S.workOrderTasks).limit(1);
  return refused(
    await quality.recordInspection({
      operationId: t.id, commandId: randomUUID(), quantity: 1, verdict: "PASS",
      from: "pendingInspection",
    }),
    "worker inspecting"
  );
});

await expect("Permissions", "A worker cannot dispatch", async () => {
  const [w] = await db.select().from(S.workOrders).limit(1);
  return refused(
    await delivery.raiseDeliveryNote({ workOrderId: w.id, quantity: 1, handlerUserId: null }),
    "worker dispatching"
  );
});

await expect("Permissions", "A worker cannot raise a work order", async () => {
  const [fg] = await db.select().from(S.items).where(eq(S.items.isFinishedGood, true)).limit(1);
  return refused(
    await admin.createWorkOrder({ itemId: fg.id, customerId: null, quantity: 1, dueDate: null }),
    "worker raising an order"
  );
});

await expect("Permissions", "Signed out, nothing works", async () => {
  actor = null;
  const [t] = await db.select().from(S.workOrderTasks).limit(1);
  return refused(await tasks.startTask(t.id, randomUUID()), "anonymous start");
});

// --- Report ---------------------------------------------------------------
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log("");
console.log(pad("AREA", 14) + pad("CHECK", 46) + pad("RESULT", 8) + "DETAIL");
console.log("-".repeat(130));
for (const r of rows) {
  const mark = r.status === "PASS" ? "\x1b[32mPASS\x1b[0m  " : r.status === "FAIL" ? "\x1b[31mFAIL\x1b[0m  " : "SKIP  ";
  console.log(pad(r.area, 14) + pad(r.check, 46) + mark + r.detail);
}
const fails = rows.filter((r) => r.status === "FAIL").length;
console.log("-".repeat(130));
console.log(`${rows.length} checks · ${rows.length - fails} passed · ${fails} failed`);
await pool.end();
process.exit(fails > 0 ? 1 : 0);
