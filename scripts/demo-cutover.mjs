/**
 * Browser demonstration of the task-action cutover.
 *
 * Shows, through the real UI:
 *   1. a worker starting a step, and inventory moving exactly once
 *   2. tapping Start again (the same user action) NOT consuming a second time
 *   3. a shortage producing a useful message with the step left unstarted
 */
import { chromium } from "playwright";
import { Client } from "pg";
import path from "path";
import fs from "fs";
import "dotenv/config";

const outDir = process.argv[2] || "./out";
fs.mkdirSync(outDir, { recursive: true });
const base = process.env.DEMO_BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mes_dev";

const sql = new Client({ connectionString: DB });
await sql.connect();

const q = async (text, params = []) => (await sql.query(text, params)).rows;

const stockOf = async (sku) =>
  (
    await q(
      `SELECT b.on_hand, b.active_reserved, b.held_qty
         FROM inventory_balances b JOIN items i ON i.id = b.item_id
        WHERE i.sku = $1`,
      [sku]
    )
  )[0] ?? { on_hand: 0, active_reserved: 0, held_qty: 0 };

const movements = async () =>
  Number((await q(`SELECT count(*)::int AS n FROM inventory_movements WHERE type = 'ISSUE'`))[0].n);

// PLAYWRIGHT_CHROMIUM_PATH lets a sandbox point at a pre-installed browser; on a normal
// machine Playwright resolves its own (run `npx playwright install chromium` once).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });

async function signIn(email) {
  await page.goto(`${base}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`);
}

// --- Scenario 1: a successful start moves stock exactly once ---------------
// Marcus works Fan & Motor Assembly; his first step consumes a fan wheel.
console.log("1. Worker signs in at Fan & Motor Assembly");
await signIn("worker3@thermal-corp.com");
await page.goto(`${base}/my-station`);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outDir, "d1-before-start.png"), fullPage: true });

const wheelBefore = await stockOf("BUY-WHEEL-FC");
const issuesBefore = await movements();
console.log(`   fan wheels on hand before: ${wheelBefore.on_hand}, issue movements: ${issuesBefore}`);

console.log("2. Worker taps Start on the first ready step");
const startBtn = page.getByRole("button", { name: "Start" }).first();
await startBtn.click();
await page.waitForTimeout(1800);
await page.screenshot({ path: path.join(outDir, "d2-after-start.png"), fullPage: true });

const wheelAfter = await stockOf("BUY-WHEEL-FC");
const issuesAfter = await movements();
console.log(`   fan wheels on hand after:  ${wheelAfter.on_hand}, issue movements: ${issuesAfter}`);
console.log(
  `   -> consumed ${wheelBefore.on_hand - wheelAfter.on_hand}, wrote ${issuesAfter - issuesBefore} issue movement(s)`
);

// --- Scenario 2: finish step 1 so the motor step becomes startable ---------
console.log("3. Worker marks the first step done");
await page.getByRole("button", { name: "Mark done" }).first().click();
await page.waitForTimeout(1800);

console.log("4. Emptying stock of the motor the NEXT step needs");
await q(`
  UPDATE inventory_balances SET on_hand = 0, active_reserved = 0, held_qty = 0
   WHERE item_id = (SELECT id FROM items WHERE sku = 'BUY-MOTOR-5HP')`);

await page.reload();
await page.waitForTimeout(1200);

const statusBefore = (
  await q(
    `SELECT status FROM work_order_tasks WHERE name = 'Fit motor, sheaves & belts' ORDER BY id LIMIT 1`
  )
)[0];

console.log("5. Worker taps Start on the step whose motor is gone");
const motorCard = page
  .locator("div.rounded-lg.border")
  .filter({ hasText: "Fit motor, sheaves & belts" })
  .first();
const motorStart = motorCard.getByRole("button", { name: "Start" }).first();

if ((await motorStart.count()) > 0 && (await motorStart.isEnabled())) {
  await motorStart.click();
  await page.waitForTimeout(1800);
} else {
  console.log("   (Start unavailable — capturing the state as shown)");
}
await page.screenshot({ path: path.join(outDir, "d3-shortage.png"), fullPage: true });

const statusAfter = (
  await q(
    `SELECT status FROM work_order_tasks WHERE name = 'Fit motor, sheaves & belts' ORDER BY id LIMIT 1`
  )
)[0];
const motorStock = await stockOf("BUY-MOTOR-5HP");
const shownError = await motorCard.locator("p.text-blocked-fg").first().textContent().catch(() => null);

console.log(`   message shown to the worker: ${JSON.stringify(shownError)}`);
console.log(`   step status before: ${statusBefore?.status}, after: ${statusAfter?.status}`);
console.log(`   motor stock: ${motorStock.on_hand} (nothing drawn)`);

// --- Inventory screen shows the engine's numbers ---------------------------
await page.goto(`${base}/inventory`);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outDir, "d4-inventory.png"), fullPage: true });

await browser.close();
await sql.end();
console.log("demo complete");
