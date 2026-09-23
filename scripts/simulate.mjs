/**
 * End-to-end simulation.
 *
 * Drives the real browser UI as an admin, four workers and a supervisor through
 * one complete job — set the product up, raise the order, build the sub-assembly,
 * hand it to final assembly, block something, clear it — and checks the database
 * after every human action.
 *
 * Nothing here calls the engine directly. Every state change goes through the same
 * screens a person uses, which is the point: the unit tests already prove the
 * engine, and they say nothing about whether the application is wired to it.
 *
 *   node scripts/simulate.mjs            (needs `npm run dev` running)
 *
 * It creates its own product with a SIM- prefix, so it can run against the seeded
 * demo data without disturbing it.
 */
import { chromium } from "playwright";
import { Client } from "pg";
import "dotenv/config";

const BASE = process.env.DEMO_BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mes_dev";
const RUN = Date.now().toString().slice(-5);

const SKU = {
  blade: `SIM-BLADE-${RUN}`,
  damper: `SIM-DAMPER-${RUN}`,
  unit: `SIM-AHU-${RUN}`,
};
const ORDER = `SIM-${RUN}`;

const sql = new Client({ connectionString: DB });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];

/**
 * Clear out anything a previous simulation left behind.
 *
 * A run that leaves debris is not repeatable: the same step names pile up across
 * runs and the next one ends up driving an earlier job's card.
 */
async function clearPreviousRuns() {
  const simItems = `SELECT id FROM items WHERE sku LIKE 'SIM-%'`;

  // Not every order this script raises ends up with a SIM- number: the
  // made-to-order form has no order-number field, so the app numbers those
  // ORD-nnnn like any other, and their sub-assembly children inherit that.
  // Matching on the order number alone left those behind, and the debris then
  // held a foreign key against the very rows this function tries to remove.
  const orders = `WITH RECURSIVE tree AS (
                    SELECT id FROM work_orders
                     WHERE order_number LIKE 'SIM-%' OR item_id IN (${simItems})
                    UNION
                    SELECT w.id FROM work_orders w JOIN tree t ON w.parent_work_order_id = t.id
                  ) SELECT id FROM tree`;
  const tasks = `SELECT id FROM work_order_tasks WHERE work_order_id IN (${orders})`;
  const lots = `SELECT id FROM stock_lots WHERE item_id IN (${simItems})`;
  const reqs = `SELECT id FROM material_requirements
                 WHERE operation_id IN (${tasks}) OR item_id IN (${simItems})`;

  await q(`DELETE FROM alerts WHERE work_order_task_id IN (${tasks}) OR work_order_id IN (${orders})`);
  await q(`DELETE FROM attachments WHERE work_order_task_id IN (${tasks}) OR work_order_id IN (${orders})`);
  await q(`DELETE FROM delivery_notes WHERE work_order_id IN (${orders})`);
  await q(`DELETE FROM disposition_records WHERE operation_id IN (${tasks}) OR requirement_id IN (${reqs})`);
  await q(`DELETE FROM operation_outputs WHERE operation_id IN (${tasks})`);
  await q(`DELETE FROM operation_dependencies WHERE operation_id IN (${tasks})
             OR depends_on_operation_id IN (${tasks}) OR requirement_id IN (${reqs})`);
  await q(`DELETE FROM reservations WHERE requirement_id IN (${reqs}) OR item_id IN (${simItems})`);
  await q(`DELETE FROM material_requirements WHERE id IN (${reqs})`);
  await q(`DELETE FROM time_entry_adjustments WHERE time_entry_id IN
             (SELECT id FROM time_entries WHERE work_order_task_id IN (${tasks}))`);
  await q(`DELETE FROM time_entries WHERE work_order_task_id IN (${tasks})`);
  await q(`DELETE FROM task_events WHERE work_order_task_id IN (${tasks})`);
  await q(`DELETE FROM quality_events WHERE work_order_task_id IN (${tasks})
             OR item_id IN (${simItems}) OR lot_id IN (${lots})`);
  await q(`DELETE FROM work_order_tasks WHERE id IN (${tasks})`);
  await q(`DELETE FROM work_orders WHERE id IN (${orders})`);
  await q(`DELETE FROM inventory_holds WHERE item_id IN (${simItems})`);
  await q(`DELETE FROM inventory_movements WHERE item_id IN (${simItems}) OR lot_id IN (${lots})`);
  await q(`DELETE FROM inventory_balances WHERE item_id IN (${simItems})`);
  await q(`DELETE FROM stock_lots WHERE id IN (${lots})`);
  await q(`DELETE FROM bom_lines WHERE parent_item_id IN (${simItems}) OR component_item_id IN (${simItems})`);
  await q(`DELETE FROM routing_steps WHERE item_id IN (${simItems})`);
  await q(`DELETE FROM items WHERE sku LIKE 'SIM-%'`);
}
await clearPreviousRuns();

// ---------------------------------------------------------------------------
// Tiny check harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let act = "";

function section(name) {
  act = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  } else {
    failures.push(`${act} → ${label}${detail ? `  (${detail})` : ""}`);
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Queries used repeatedly
// ---------------------------------------------------------------------------
const itemId = async (sku) => (await one(`SELECT id FROM items WHERE sku = $1`, [sku]))?.id;
const stock = async (sku) =>
  (await one(
    `SELECT COALESCE(b.on_hand,0) AS on_hand, COALESCE(b.active_reserved,0) AS reserved
       FROM items i LEFT JOIN inventory_balances b ON b.item_id = i.id
      WHERE i.sku = $1`,
    [sku]
  )) ?? { on_hand: 0, reserved: 0 };
const movementCount = async (sku, type) =>
  Number(
    (
      await one(
        `SELECT count(*)::int AS n FROM inventory_movements m
           JOIN items i ON i.id = m.item_id
          WHERE i.sku = $1 AND m.type = $2`,
        [sku, type]
      )
    ).n
  );
const taskRow = async (name) =>
  await one(
    `SELECT t.* FROM work_order_tasks t
       JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.name = $1 AND (w.order_number = $2 OR w.order_number LIKE $2 || '-%')
      ORDER BY t.id LIMIT 1`,
    [name, ORDER]
  );

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

async function signIn(who) {
  // Sign out from inside the app rather than from /login — the session cookie has
  // to be cleared by the app, and a signed-in visit to /login is bounced.
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(500);
  const out = page.getByRole("button", { name: "Sign out" });
  if (await out.count()) {
    await out.click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
  } else {
    await page.goto(`${BASE}/login`);
  }
  await page.waitForTimeout(400);

  await page.fill('input[type="email"]', `${who}@thermal-corp.com`);
  await page.fill('input[type="password"]', "password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  try {
    await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  } catch {
    // One retry: a rejected submit leaves the form in place with a message.
    const shown = await page.locator("body").innerText();
    await page.fill('input[type="email"]', `${who}@thermal-corp.com`);
    await page.fill('input[type="password"]', "password123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 20000 }).catch(() => {
      throw new Error(`could not sign in as ${who}. Page said: ${shown.slice(0, 200)}`);
    });
  }
  await page.waitForTimeout(400);
}

/** Click a button and wait for the server action to land. */
async function act_(locator, settle = 1400) {
  await locator.click();
  await page.waitForTimeout(settle);
}

/**
 * The card for a named step on a station page, scoped to THIS run's order — the
 * same step name exists on every previous simulation's order, and picking the
 * first one on the page silently drives someone else's job.
 */
const cardFor = (name) =>
  page.locator(`[data-step-card="${name}"]`).filter({ hasText: ORDER }).first();

/**
 * Open the station a step actually sits at.
 *
 * `/my-station` is a station picker, not a job list — the cards live one level
 * down at `/my-station/{stationId}`. Asking the database which station the step
 * is at beats clicking through the picker by name, because two stations can be
 * mid-rename and the id cannot be ambiguous.
 */
async function openStationFor(name) {
  const row = await one(
    `SELECT t.station_id
       FROM work_order_tasks t
       JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.name = $1 AND w.order_number LIKE $2
      ORDER BY t.id DESC
      LIMIT 1`,
    [name, `${ORDER}%`]
  );
  if (!row?.station_id) throw new Error(`no station found for step "${name}" on ${ORDER}`);
  await page.goto(`${BASE}/my-station/${row.station_id}`);
  await page.waitForTimeout(700);
}

/**
 * Walk to the rack and take everything this card is waiting for.
 *
 * Start is refused while material is still on the shelf, so the script has to do
 * what the worker does. Batches are scanned where the stock carries a label and
 * declared unlabelled where it does not — opening balances have no batch behind
 * them, and that is the case most likely to be got wrong.
 */
async function collectFor(card) {
  const lines = card.locator("li");
  for (let i = 0; i < (await lines.count()); i++) {
    const line = lines.nth(i);
    const take = line.getByRole("button", { name: /^Scan to take \d+$/ });
    if ((await take.count()) === 0) continue;

    // The line reads "Damper Blade 4471 0/2 ea" — the running count has to come
    // off before the name will match an item, or every pick claims to be unlabelled.
    const itemName = (await line.innerText())
      .split("\n")[0]
      .replace(/\s*\d+\/\d+\b.*$/, "")
      .trim();
    await act_(take.first(), 500);

    const batch = await one(
      `SELECT l.batch_number FROM stock_lots l
         JOIN items i ON i.id = l.item_id
        WHERE i.name = $1 AND l.batch_number IS NOT NULL
        ORDER BY l.received_at LIMIT 1`,
      [itemName]
    );
    if (batch?.batch_number) {
      await line.getByPlaceholder("Scan the batch label").first().fill(batch.batch_number);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1600);
    } else {
      await act_(line.getByRole("button", { name: "No label on it" }).first(), 1600);
    }
  }
}

async function startStep(name) {
  await openStationFor(name);
  const card = cardFor(name);
  await collectFor(card);
  await act_(card.getByRole("button", { name: /^(Start|Clock on)$/ }).first());
}

/** Finishing is two presses now: Stop, then which kind of stop. */
async function finishStep(name) {
  await openStationFor(name);
  const card = cardFor(name);
  await act_(card.getByRole("button", { name: "Stop" }).first(), 500);
  await act_(card.getByRole("button", { name: "Job done" }).first(), 1800);
}

// ===========================================================================
// ACT 1 — Admin sets up a product nobody has made before
// ===========================================================================
section("1. Admin — define a new product, its process and its parts");

await signIn("admin");

async function createItem({ sku, name, made, uom, opening, reorder }) {
  await page.goto(`${BASE}/admin/products`);
  await page.waitForTimeout(600);
  await page.getByLabel("SKU").fill(sku);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Where it comes from").selectOption(made ? "MANUFACTURED" : "PURCHASED");
  await page.getByLabel("Unit").fill(uom);
  await page.getByLabel("Opening stock").fill(String(opening ?? 0));
  await page.getByLabel("Reorder at").fill(String(reorder ?? 0));
  await act_(page.getByRole("button", { name: "Add product" }));

  // Fail here, with what the screen said, rather than twenty checks later with
  // nothing to go on.
  if (!(await one(`SELECT id FROM items WHERE sku = $1`, [sku]))) {
    const body = await page.locator("body").innerText();
    throw new Error(`${sku} was not created. The screen says:\n${body}`);
  }
}

await createItem({
  sku: SKU.blade,
  name: `Damper Blade ${RUN}`,
  made: false,
  uom: "ea",
  opening: 10,
  reorder: 4,
});
await createItem({ sku: SKU.damper, name: `Damper Section ${RUN}`, made: true, uom: "ea" });
await createItem({ sku: SKU.unit, name: `Sim Air Handler ${RUN}`, made: true, uom: "ea" });

const blade = await one(`SELECT * FROM items WHERE sku = $1`, [SKU.blade]);
check("purchased part created", !!blade, SKU.blade);
check("reorder point persisted", blade?.reorder_point === 4, `stored ${blade?.reorder_point}`);
check(
  "opening stock went through the ledger, not straight into a balance",
  (await movementCount(SKU.blade, "RECEIPT")) === 1 &&
    Number((await stock(SKU.blade)).on_hand) === 10,
  `${(await stock(SKU.blade)).on_hand} on hand, 1 receipt`
);
check("sub-assembly created as made-here", !!(await itemId(SKU.damper)));
check("finished product created", !!(await itemId(SKU.unit)));

// --- routing -------------------------------------------------------------
async function addStep(itemDbId, name, station, minutes) {
  await page.goto(`${BASE}/admin/products/${itemDbId}`);
  await page.waitForTimeout(700);
  await page.getByLabel("Next step").fill(name);
  await page.getByLabel("Station").selectOption({ label: station });
  await page.getByLabel("Minutes").fill(String(minutes));
  await act_(page.getByRole("button", { name: "Add step" }));
}

const damperId = await itemId(SKU.damper);
const unitId = await itemId(SKU.unit);

await addStep(damperId, "Cut damper blades", "Coil Line", 30);
await addStep(damperId, "Assemble damper section", "Fan & Motor Assembly", 45);
await addStep(unitId, "Frame up the casing", "Frame Fab", 60);
await addStep(unitId, "Fit damper section", "Final Assembly", 40);

const damperSteps = await q(
  `SELECT name, sequence FROM routing_steps WHERE item_id = $1 ORDER BY sequence`,
  [damperId]
);
check(
  "sub-assembly routing has two steps in order",
  damperSteps.length === 2 && damperSteps[0].name === "Cut damper blades",
  damperSteps.map((s) => s.name).join(" → ")
);
const unitSteps = await q(
  `SELECT name, sequence FROM routing_steps WHERE item_id = $1 ORDER BY sequence`,
  [unitId]
);
check(
  "product routing has two steps in order",
  unitSteps.length === 2 && unitSteps[1].name === "Fit damper section",
  unitSteps.map((s) => s.name).join(" → ")
);

// --- bill of materials ---------------------------------------------------
async function addBomLine(parentDbId, componentSku, qty, atStepName) {
  await page.goto(`${BASE}/admin/products/${parentDbId}`);
  await page.waitForTimeout(700);
  // Options are labelled "Name (SKU)"; selecting by value avoids depending on
  // exactly how that label is composed.
  await page.getByLabel("Component").selectOption(String(await itemId(componentSku)));
  await page.getByLabel("Qty").fill(String(qty));
  await page.getByLabel("Taken from stock at").selectOption({ label: atStepName });
  await act_(page.getByRole("button", { name: "Add", exact: true }));
}

await addBomLine(damperId, SKU.blade, 2, "Cut damper blades");
await addBomLine(unitId, SKU.damper, 1, "Fit damper section");

const bomDamper = await one(
  `SELECT b.quantity, r.name AS at_step FROM bom_lines b
     LEFT JOIN routing_steps r ON r.id = b.consumed_at_routing_step_id
    WHERE b.parent_item_id = $1`,
  [damperId]
);
check(
  "component is tied to the operation that consumes it",
  bomDamper?.quantity === 2 && bomDamper?.at_step === "Cut damper blades",
  `${bomDamper?.quantity} × at "${bomDamper?.at_step}"`
);

// ===========================================================================
// ACT 2 — Admin raises the job
// ===========================================================================
section("2. Admin — raise the work order");

await page.goto(`${BASE}/orders/new`);
await page.waitForTimeout(700);
await page.getByLabel("Work order number").fill(ORDER);
await page.getByLabel("Product").selectOption(String(unitId));
await page.getByLabel("Quantity", { exact: true }).fill("1");
await act_(page.getByRole("button", { name: "Create work order" }), 2500);

const parent = await one(`SELECT * FROM work_orders WHERE order_number = $1`, [ORDER]);
check("parent work order exists and is released", parent?.status === "RELEASED", parent?.status);

const child = await one(`SELECT * FROM work_orders WHERE parent_work_order_id = $1`, [parent?.id]);
check("a sub-assembly order was raised automatically", !!child, child?.order_number);

const parentTasks = await q(
  `SELECT name, status FROM work_order_tasks WHERE work_order_id = $1 ORDER BY sequence`,
  [parent?.id]
);
check("the product's steps were created", parentTasks.length === 2, parentTasks.map((t) => t.name).join(", "));

const deps = await q(
  `SELECT d.type FROM operation_dependencies d
     JOIN work_order_tasks t ON t.id = d.operation_id
    WHERE t.work_order_id = $1`,
  [parent?.id]
);
check(
  "the routing chain became a real dependency",
  deps.filter((d) => d.type === "FULL_COMPLETION").length >= 1
);
check(
  "final assembly was made to depend on the sub-assembly",
  deps.some((d) => d.type === "REQUIRED_QUANTITY") && deps.some((d) => d.type === "QUALITY_ACCEPTANCE"),
  deps.map((d) => d.type).join(", ")
);

const reqs = await q(
  `SELECT mr.required_qty, i.sku FROM material_requirements mr
     JOIN items i ON i.id = mr.item_id
     JOIN work_order_tasks t ON t.id = mr.operation_id
    WHERE t.work_order_id = $1`,
  [child?.id]
);
check(
  "the sub-assembly's material requirement was worked out from the BOM",
  reqs.length === 1 && reqs[0].required_qty === 2,
  `${reqs[0]?.required_qty} × ${reqs[0]?.sku}`
);

// ===========================================================================
// ACT 3 — The sub-assembly gets built
// ===========================================================================
section("3. Worker at Coil Line — cut the blades");

await signIn("worker2");

await openStationFor("Cut damper blades");
check(
  "the new step appears in this worker's queue",
  (await cardFor("Cut damper blades").count()) > 0
);

const before = await stock(SKU.blade);
const issuesBefore = await movementCount(SKU.blade, "ISSUE");

await startStep("Cut damper blades");

const afterStart = await stock(SKU.blade);
/*
  The clock cannot start until the material is in the worker's hands. Start used
  to earmark the stock and let them begin, which is how a job could be signed off
  having consumed nothing — the shelf said full and the unit was built.
*/
check(
  "the blades left the shelf when they were collected, before the clock started",
  Number(afterStart.on_hand) === Number(before.on_hand) - 2,
  `${before.on_hand} on hand before, ${afterStart.on_hand} after`
);
check(
  "and collecting them wrote exactly one issue movement",
  (await movementCount(SKU.blade, "ISSUE")) - issuesBefore === 1
);
const cutTask = await taskRow("Cut damper blades");
check("the step is now running", cutTask.status === "IN_PROGRESS", cutTask.status);
check(
  "the clock is running for this worker",
  !!(await one(
    `SELECT id FROM time_entries WHERE work_order_task_id = $1 AND ended_at IS NULL`,
    [cutTask.id]
  ))
);

// A second person joining the same running step must not draw the material again.
// This is the double-consumption defect the whole engine exists to prevent, and it
// is reachable through the UI: the worker who started it no longer has a Start
// button, but anyone else who can act at that station has a "Clock on".
await signIn("supervisor");
await openStationFor("Cut damper blades");
await act_(cardFor("Cut damper blades").getByRole("button", { name: "Clock on" }).first(), 1600);
check(
  "a second person clocking on does not draw two more blades",
  Number((await stock(SKU.blade)).on_hand) === Number(afterStart.on_hand),
  `still ${(await stock(SKU.blade)).on_hand} on hand`
);
check(
  "and only one issue movement was ever written",
  (await movementCount(SKU.blade, "ISSUE")) - issuesBefore === 1
);

await signIn("worker2");
await finishStep("Cut damper blades");
check("the step is done", (await taskRow("Cut damper blades")).status === "DONE");

section("4. Worker at Fan & Motor Assembly — assemble the damper");

await signIn("worker3");
await startStep("Assemble damper section");
check(
  "the second step could start once the first was finished",
  (await taskRow("Assemble damper section")).status === "IN_PROGRESS"
);

await finishStep("Assemble damper section");
const damperTask = await taskRow("Assemble damper section");
check("the sub-assembly is complete", damperTask.status === "DONE");

const allocated = await one(
  `SELECT COALESCE(SUM(CASE WHEN kind = 'ALLOCATE' THEN quantity ELSE 0 END), 0)::int AS n
     FROM disposition_records WHERE operation_id = $1`,
  [damperTask.id]
);
check(
  "finishing it handed the damper to the order waiting for it",
  allocated.n === 1,
  `${allocated.n} allocated`
);

const earlyAlert = await one(
  `SELECT id FROM alerts WHERE kind = 'STEP_READY' AND work_order_id = $1 AND acknowledged_at IS NULL`,
  [parent?.id]
);
check(
  "nobody is told yet — final assembly still has an unfinished step of its own",
  !earlyAlert,
  "sending someone to a step they still cannot start is worse than silence"
);

// ===========================================================================
// ACT 5 — Final assembly, including the step that must wait its turn
// ===========================================================================
section("5. Worker at Final Assembly — the step that was waiting");

await signIn("worker4");
await openStationFor("Fit damper section");
const fitCard = cardFor("Fit damper section");
/*
  The card deliberately leaves Start pressable for a step waiting on an earlier one
  in its own routing — those clear constantly, and a greyed button goes stale. What
  must hold is that pressing it does not start the step, and says why.
*/
const fitStart = fitCard.getByRole("button", { name: /^(Start|Clock on)$/ }).first();
if ((await fitStart.count()) > 0 && (await fitStart.isEnabled())) {
  await act_(fitStart, 1500);
}
const fitBefore = await taskRow("Fit damper section");
check(
  "it still cannot start — the casing has not been framed yet",
  fitBefore.status !== "IN_PROGRESS",
  /Earlier step|Waiting|cannot|first/i.test(await fitCard.innerText())
    ? "and the card says what it is waiting on"
    : fitBefore.status
);

section("6. Worker at Frame Fab — clear the predecessor");
await signIn("worker1");
await startStep("Frame up the casing");
await finishStep("Frame up the casing");
check("the casing is framed", (await taskRow("Frame up the casing")).status === "DONE");

const readyAlert = await one(
  `SELECT a.*, s.name AS station FROM alerts a
     LEFT JOIN stations s ON s.id = a.audience_station_id
    WHERE a.kind = 'STEP_READY' AND a.work_order_id = $1 AND a.acknowledged_at IS NULL`,
  [parent?.id]
);
check(
  "NOW final assembly is told it can go",
  !!readyAlert,
  readyAlert ? `→ ${readyAlert.station}: "${readyAlert.title}"` : "no alert raised"
);

section("7. Final Assembly again — now it goes");
await signIn("worker4");

await page.goto(`${BASE}/alerts`);
await page.waitForTimeout(900);
check(
  "the alert is on this worker's own alerts page",
  (await page.getByText("Fit damper section").count()) > 0
);

await startStep("Fit damper section");
const fitTask = await taskRow("Fit damper section");
check("final assembly started", fitTask.status === "IN_PROGRESS", fitTask.status);
check(
  "starting it cleared the alert that sent them there",
  !(await one(
    `SELECT id FROM alerts WHERE kind = 'STEP_READY' AND work_order_task_id = $1 AND acknowledged_at IS NULL`,
    [fitTask.id]
  ))
);

// ===========================================================================
// ACT 8 — Something goes wrong
// ===========================================================================
section("8. Worker — can't continue");

await openStationFor("Fit damper section");
const blockCard = cardFor("Fit damper section");
/*
  Two presses and no typing: Down, then the reason itself. The worker card is
  deliberately press-only, so the note kept against the step is the reason code's
  own wording rather than free text.
*/
await act_(blockCard.getByRole("button", { name: "Down" }).first(), 600);
const reason = blockCard.getByRole("button", { name: /Waiting on material/i }).first();
await act_(
  (await reason.count()) > 0
    ? reason
    : blockCard.getByRole("button", { name: /^Waiting on/i }).first(),
  1600
);

const blocked = await taskRow("Fit damper section");
check("the step is blocked", blocked.status === "BLOCKED", blocked.status);
check(
  "and the reason is kept against it",
  /waiting on/i.test(blocked.blocked_note ?? ""),
  blocked.blocked_note
);

const blockAlert = await one(
  `SELECT * FROM alerts WHERE kind = 'STEP_BLOCKED' AND work_order_task_id = $1 AND acknowledged_at IS NULL`,
  [blocked.id]
);
check("a supervisor alert was raised", !!blockAlert, blockAlert?.title);

// ===========================================================================
// ACT 9 — Supervisor's view
// ===========================================================================
section("9. Supervisor — the whole floor");

await signIn("supervisor");

await page.goto(`${BASE}/alerts`);
await page.waitForTimeout(900);
check(
  "the blocked step is on the supervisor's alerts",
  /Fit damper section/.test(await page.locator("body").innerText())
);

await page.goto(`${BASE}/waiting`);
await page.waitForTimeout(900);
const waitingText = await page.locator("body").innerText();
check("the waiting screen loads and reports a count", /held up/i.test(waitingText));

await page.goto(`${BASE}/reports`);
await page.waitForTimeout(900);
const reportText = await page.locator("body").innerText();
check("time recorded by this simulation shows in reports", /hours charged/i.test(reportText));
check(
  "the steps just run appear in the averages",
  /Cut damper blades/.test(reportText) || /Frame up the casing/.test(reportText)
);

await page.goto(`${BASE}/timesheets`);
await page.waitForTimeout(900);
const sheetText = await page.locator("body").innerText();
check("the supervisor can see the workers' hours", /Cut damper blades/.test(sheetText));

// Unblock, from the supervisor's own screen.
await openStationFor("Fit damper section");
await act_(cardFor("Fit damper section").getByRole("button", { name: "Back up" }).first(), 1600);
check("supervisor cleared the block", (await taskRow("Fit damper section")).status !== "BLOCKED");
check(
  "clearing it closed the alert without anyone tidying up",
  !(await one(
    `SELECT id FROM alerts WHERE kind = 'STEP_BLOCKED' AND work_order_task_id = $1 AND acknowledged_at IS NULL`,
    [blocked.id]
  ))
);

// ===========================================================================
// ACT 10 — Shortage, and the books
// ===========================================================================
section("10. A shortage, and whether the books balance");

// Take the blades away and raise a second order that needs them.
await q(
  `UPDATE inventory_balances SET on_hand = 0, active_reserved = 0, held_qty = 0
     WHERE item_id = (SELECT id FROM items WHERE sku = $1)`,
  [SKU.blade]
);

await signIn("admin");
await page.goto(`${BASE}/orders/new`);
await page.waitForTimeout(900);
await page.getByLabel("Work order number").fill(`${ORDER}-B`);
await page.getByLabel("Product").selectOption(String(unitId));
await act_(page.getByRole("button", { name: "Create work order" }), 2500);

await signIn("worker2");
await openStationFor("Cut damper blades");
const shortCard = page
  .locator('[data-step-card="Cut damper blades"]')
  .filter({ hasText: `${ORDER}-B` })
  .first();
const shortStart = shortCard.getByRole("button", { name: /^(Start|Clock on)$/ }).first();
if ((await shortStart.count()) > 0 && (await shortStart.isEnabled())) {
  await act_(shortStart, 1600);
}
const shortText = await shortCard.innerText();
check(
  "the worker is told what is missing, not just refused",
  /Short \d+ unit/.test(shortText),
  shortText.split("\n").find((l) => /Short \d+ unit/.test(l)) ?? shortText.slice(0, 80)
);
check(
  "and nothing was drawn from a balance that is already empty",
  Number((await stock(SKU.blade)).on_hand) === 0
);

// ===========================================================================
// ACT 11 — A supervisor puts a name on a job
// ===========================================================================
section("11. Supervisor — hand a step to a named person");

// Put the blades back so the step the supervisor hands out can actually be done.
// Handing someone work they cannot start is the dead end the guard exists to
// prevent, and it is not what this act is testing.
const bladeItem = await itemId(SKU.blade);
const loc = await one(`SELECT id FROM inventory_locations LIMIT 1`);
await q(
  `INSERT INTO inventory_balances (item_id, location_id, on_hand, active_reserved, held_qty)
   VALUES ($1, $2, 50, 0, 0)
   ON CONFLICT (item_id, location_id) DO UPDATE SET on_hand = 50, active_reserved = 0, held_qty = 0`,
  [bladeItem, loc.id]
);

await signIn("supervisor");
await openStationFor("Cut damper blades");

const handCard = page
  .locator('[data-step-card="Cut damper blades"]')
  .filter({ hasText: `${ORDER}-B` })
  .first();
await act_(handCard.getByRole("button", { name: /Give to someone|Reassign/ }).first(), 700);
// The card offers names as buttons rather than a dropdown — whoever is handing the
// job out is standing at the machine, and the shift list is short.
await act_(handCard.getByRole("button", { name: "Jordan Mills", exact: true }).first(), 1800);

const handedTask = await one(
  `SELECT t.id, t.assigned_to_user_id, t.assigned_by_user_id, u.name AS assignee
     FROM work_order_tasks t
     JOIN work_orders w ON w.id = t.work_order_id
     LEFT JOIN users u ON u.id = t.assigned_to_user_id
    WHERE w.order_number LIKE $1 AND t.name = 'Cut damper blades'`,
  [`${ORDER}-B%`]
);
check("the step now has a name on it", handedTask?.assignee === "Jordan Mills", handedTask?.assignee ?? "nobody");
check("and a record of who put it there", !!handedTask?.assigned_by_user_id);

const handAlert = await one(
  `SELECT a.id, a.audience_user_id, a.audience_station_id, a.kind
     FROM alerts a WHERE a.work_order_task_id = $1 AND a.kind = 'ASSIGNED_TO_YOU'
      AND a.acknowledged_at IS NULL`,
  [handedTask.id]
);
check("the person was told, by name", !!handAlert, handAlert ? `audience user ${handAlert.audience_user_id}` : "no alert");
check(
  "and the whole station was NOT told",
  handAlert?.audience_station_id === null,
  "being given a job should not notify everyone standing near you"
);

// Now from that worker's side.
await signIn("worker2");
const workerHomeText = await page.locator("body").innerText();
check(
  "it is the first thing on their home screen",
  /Yours to do next/i.test(workerHomeText) && /Cut damper blades/.test(workerHomeText),
  workerHomeText.split("\n").find((l) => /Yours to do/i.test(l)) ?? "not on the home screen"
);

await page.goto(`${BASE}/alerts`);
await page.waitForTimeout(900);
check(
  "and it is in their alerts under their own name",
  /gave you/i.test(await page.locator("body").innerText())
);

await openStationFor("Cut damper blades");
const myHanded = page
  .locator('[data-step-card="Cut damper blades"]')
  .filter({ hasText: `${ORDER}-B` })
  .first();
check("the card is marked as theirs", /Yours/.test(await myHanded.innerText()));
await collectFor(myHanded);
await act_(myHanded.getByRole("button", { name: /^(Start|Clock on)$/ }).first(), 1800);
check(
  "starting it closed the alert — the news has been acted on",
  !(await one(
    `SELECT id FROM alerts WHERE kind = 'ASSIGNED_TO_YOU' AND work_order_task_id = $1
       AND acknowledged_at IS NULL`,
    [handedTask.id]
  ))
);

// ===========================================================================
// ACT 12 — One person, two machines
// ===========================================================================
section("12. One worker on two steps at once — is the time counted twice?");

// Jordan is already clocked on to the blade step on order B. A third order gives
// the same station a second startable step, which is the only honest way to get
// one person genuinely running two jobs at once — the situation whose labour
// figures are wrong in every system that does not prorate.
await signIn("admin");
await page.goto(`${BASE}/orders/new`);
await page.waitForTimeout(900);
await page.getByLabel("Work order number").fill(`${ORDER}-C`);
await page.getByLabel("Product").selectOption(String(unitId));
await act_(page.getByRole("button", { name: "Create work order" }), 2500);

await signIn("worker2");

const secondReady = await one(
  `SELECT t.id, t.name, w.order_number
     FROM work_order_tasks t
     JOIN work_orders w ON w.id = t.work_order_id
    WHERE w.order_number LIKE $1
      AND t.station_id = (SELECT station_id FROM users WHERE email = 'worker2@thermal-corp.com')
      AND t.status = 'PENDING'
    LIMIT 1`,
  [`${ORDER}-C%`]
);
check("a second job is waiting at the same station", !!secondReady, secondReady?.order_number ?? "none");

if (secondReady) {
  await openStationFor(secondReady.name);
  const secondCard = page
    .locator(`[data-step-card="${secondReady.name}"]`)
    .filter({ hasText: secondReady.order_number })
    .first();
  // Start is refused until the material is in their hands, so fetch it first.
  await collectFor(secondCard);
  const secondStart = secondCard.getByRole("button", { name: /^(Start|Clock on)$/ }).first();
  if ((await secondStart.count()) > 0 && (await secondStart.isEnabled())) {
    await act_(secondStart, 1800);
  }
}

const openNow = await q(
  `SELECT te.id FROM time_entries te
     JOIN users u ON u.id = te.user_id
    WHERE u.email = 'worker2@thermal-corp.com' AND te.ended_at IS NULL`
);
check(
  "the worker is clocked on to more than one step",
  openNow.length >= 2,
  `${openNow.length} open clock${openNow.length === 1 ? "" : "s"}`
);

if (openNow.length >= 2) {
  await openStationFor("Cut damper blades");
  const stationText = await page.locator("body").innerText();
  check(
    "and is told on the spot that the time is being shared",
    /time is being shared|split between them/i.test(stationText),
    "nobody should discover this from a variance a month later"
  );

  // Close them both and read the books. Stopping asks why: a break closes the
  // clock without declaring the job finished.
  for (const name of [secondReady?.name, "Cut damper blades"].filter(Boolean)) {
    await openStationFor(name);
    const cards = page.locator(`[data-step-card="${name}"]`);
    for (let i = 0; i < (await cards.count()); i++) {
      const c = cards.nth(i);
      const stop = c.getByRole("button", { name: "Stop", exact: true });
      if ((await stop.count()) === 0) continue;
      await act_(stop.first(), 600);
      await act_(c.getByRole("button", { name: "Break", exact: true }).first(), 1500);
    }
  }

  const entries = await q(
    `SELECT te.started_at, te.ended_at, te.duration_seconds
       FROM time_entries te JOIN users u ON u.id = te.user_id
      WHERE u.email = 'worker2@thermal-corp.com' AND te.ended_at IS NOT NULL
      ORDER BY te.started_at DESC LIMIT 5`
  );
  // Any overlapping pair proves the point. Taking the two most recently started
  // assumed they were the two that had been running together, which they need
  // not be once a third clock is in play.
  const overlapping = entries.some((a, i) =>
    entries.some(
      (b, j) =>
        i !== j &&
        new Date(a.started_at) < new Date(b.ended_at) &&
        new Date(b.started_at) < new Date(a.ended_at)
    )
  );
  check(
    "the two sessions really did overlap",
    overlapping,
    overlapping ? "" : `${entries.length} closed sessions, none of them at the same time`
  );

  await signIn("supervisor");
  await page.goto(`${BASE}/timesheets`);
  await page.waitForTimeout(1000);
  const tsText = await page.locator("body").innerText();
  check(
    "the timesheet shows clock time and charged time separately",
    /On the clock/.test(tsText) && /Charged to the job/.test(tsText)
  );
  check(
    "and says which entries were shared rather than hiding the split",
    /shared with \d+ other step/.test(tsText),
    tsText.split("\n").find((l) => /shared with/.test(l)) ?? "no shared row shown"
  );
}


// ===========================================================================
// ACT 13 — Booking a delivery in, with the heat number that makes it traceable
// ===========================================================================
section("13. Stores — receive a batch, label it, and trace it into a job");

await signIn("admin");
await page.goto(`${BASE}/inventory`);
await page.waitForTimeout(1200);

await act_(page.getByRole("button", { name: "Book a delivery in" }).first(), 900);

const HEAT = `HT-${RUN}`;
const BATCH = `BT-${RUN}`;
await page.getByLabel("Item").selectOption(String(bladeItem));
await page.getByLabel(/^Quantity/).fill("12");
await page.getByLabel(/Heat number/).fill(HEAT);
await page.getByLabel(/Batch number/).fill(BATCH);
await page.getByLabel(/Where it sits/).fill("IN Bay 09");
await act_(page.getByRole("button", { name: /^Receive$/ }).first(), 2200);

const lotRow = await one(
  `SELECT l.id, l.heat_number, l.batch_number, l.storage_location
     FROM stock_lots l WHERE l.batch_number = $1`,
  [BATCH]
);
check("the batch exists with its heat number", lotRow?.heat_number === HEAT, lotRow?.heat_number ?? "no lot");
check("and where it physically sits", lotRow?.storage_location === "IN Bay 09");

check(
  "the receipt movement carries the lot, so the trace starts here",
  !!(await one(
    `SELECT id FROM inventory_movements WHERE lot_id = $1 AND type = 'RECEIPT'`,
    [lotRow.id]
  ))
);

// The label is offered immediately, which is the only moment anyone prints one.
const labelText = await page.locator("body").innerText();
check("a printable label is offered straight away", labelText.includes(BATCH));

await page.goto(`${BASE}/inventory?q=${BATCH}`);
await page.waitForTimeout(1200);
check(
  "and the batch is on the stock list with its own barcode",
  (await page.locator(`[data-lot-batch="${BATCH}"] svg`).count()) > 0
);

await page.goto(`${BASE}/inventory`);
await page.waitForTimeout(1200);

// Scanning it finds it — the same code path a handheld scanner drives.
await page.getByPlaceholder("Scan or type a batch code").fill(BATCH);
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
check(
  "scanning the code finds that batch on the page",
  !/Nothing on this page is labelled/.test(await page.locator("body").innerText())
);

// Now consume it, and ask the question a customer eventually asks.
//
// A fresh order is raised for this on purpose. Every earlier issue in this run
// drew on opening stock that has no lot behind it, so tracing one of those would
// correctly return "unknown" and prove nothing about the trace working.
await signIn("admin");

// Take the unlotted blades out of the picture so the only stock that can satisfy
// this order is the batch just booked in.
await q(
  `UPDATE inventory_balances SET on_hand = $2, active_reserved = 0, held_qty = 0
     WHERE item_id = $1`,
  [bladeItem, 12]
);

await page.goto(`${BASE}/orders/new`);
await page.waitForTimeout(900);
await page.getByLabel("Work order number").fill(`${ORDER}-D`);
await page.getByLabel("Product").selectOption(String(unitId));
await act_(page.getByRole("button", { name: "Create work order" }), 2500);

const traceTask = await one(
  `SELECT t.id FROM work_order_tasks t
     JOIN work_orders w ON w.id = t.work_order_id
    WHERE w.order_number LIKE $1 AND t.name = 'Cut damper blades'
    LIMIT 1`,
  [`${ORDER}-D%`]
);
check("a fresh job needs those blades", !!traceTask);

await signIn("worker2");
await openStationFor("Cut damper blades");
const traceCard = page
  .locator('[data-step-card="Cut damper blades"]')
  .filter({ hasText: `${ORDER}-D` })
  .first();
const traceStart = traceCard.getByRole("button", { name: /^(Start|Clock on)$/ }).first();
if ((await traceStart.count()) > 0 && (await traceStart.isEnabled())) await act_(traceStart, 2000);

// Starting does not issue anything. The worker scans the pallet they actually
// took, and that scan is what puts a heat number in the ledger — the whole point
// of the trace. Driving the clock alone would prove nothing.
const bladeLine = traceCard.locator("li").filter({ hasText: `Damper Blade ${RUN}` }).first();
const takeBlades = bladeLine.getByRole("button", { name: /^Scan to take \d+$/ }).first();
if ((await takeBlades.count()) > 0) {
  await act_(takeBlades, 700);
  await bladeLine.getByPlaceholder("Scan the batch label").first().fill(BATCH);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2200);
}
check(
  "the scan is what draws the stock, not the clock",
  /Took \d+ from/.test(await traceCard.innerText()),
  (await traceCard.innerText()).split("\n").find((l) => /Took|cannot|Nothing/.test(l)) ??
    "no scan result"
);

const consumed = await q(
  `SELECT l.heat_number, -SUM(m.quantity)::int AS qty
     FROM inventory_movements m
     JOIN stock_lots l ON l.id = m.lot_id
     JOIN material_requirements r ON r.id = m.requirement_id
    WHERE r.operation_id = $1 AND m.type = 'ISSUE'
    GROUP BY l.heat_number`,
  [traceTask?.id ?? -1]
);
check(
  "which heat went into this step is answerable from the ledger",
  consumed.length > 0 && consumed.some((c) => c.heat_number === HEAT),
  consumed.map((c) => `${c.heat_number}: ${c.qty}`).join(", ") || "nothing traced"
);

// ===========================================================================
// Reconciliation: every balance must equal the sum of its own movements.
const drift = await q(`
  SELECT i.sku,
         b.on_hand,
         COALESCE(SUM(
           CASE m.type
             WHEN 'RECEIPT' THEN m.quantity
             WHEN 'PRODUCTION_RECEIPT' THEN m.quantity
             WHEN 'RETURN' THEN m.quantity
             WHEN 'ISSUE' THEN -m.quantity
             WHEN 'SCRAP' THEN -m.quantity
             WHEN 'SHIPMENT' THEN -m.quantity
             ELSE 0 END), 0) AS ledger
    FROM inventory_balances b
    JOIN items i ON i.id = b.item_id
    LEFT JOIN inventory_movements m ON m.item_id = b.item_id AND m.location_id = b.location_id
   WHERE i.sku LIKE 'SIM-%'
   GROUP BY i.sku, b.on_hand
`);
const mismatched = drift.filter((d) => Number(d.on_hand) !== Number(d.ledger));
check(
  "every stock balance equals the sum of its own movements",
  // The blade balance was zeroed by hand above, so it is expected to disagree.
  mismatched.every((d) => d.sku === SKU.blade),
  mismatched.length
    ? `only the hand-edited ${mismatched.map((d) => d.sku).join(", ")}`
    : "all balances agree"
);

// ---------------------------------------------------------------------------
await browser.close();
await sql.end();

console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  \x1b[31m•\x1b[0m ${f}`);
  process.exit(1);
}
console.log("Every role completed its part of the job.\n");
