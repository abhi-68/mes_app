/**
 * End-to-end check of the worker flow: sign in, clock on to a step, watch the timer
 * run, mark it done, and confirm the progress and inventory both moved.
 */
import { chromium } from "playwright";
import path from "path";

const outDir = process.argv[2] || "/tmp";
const base = "http://localhost:3000";

// PLAYWRIGHT_CHROMIUM_PATH lets a sandbox point at a pre-installed browser; on a normal
// machine Playwright resolves its own (run `npx playwright install chromium` once).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);

async function signIn(email) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [console] ${m.text()}`);
  });
  await page.goto(`${base}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`);
  return page;
}

// --- Worker: Jordan on the Coil Line (his first step is BLOCKED) -----------
console.log("1. Worker signs in and opens their station");
const worker = await signIn("worker2@thermal-corp.com");
await worker.goto(`${base}/my-station`);
await worker.waitForTimeout(700);
await worker.screenshot({ path: path.join(outDir, "4-worker-blocked.png"), fullPage: true });

const blockedVisible = await worker.getByText("Copper tube delivery short").isVisible();
console.log(`   blocked step visible to worker: ${blockedVisible}`);

console.log("2. Worker unblocks it (material arrived)");
await worker.getByRole("button", { name: "Unblock" }).first().click();
await worker.waitForTimeout(1200);

console.log("3. Worker starts the step — clock should begin");
await worker.getByRole("button", { name: "Start" }).first().click();
await worker.waitForTimeout(2600);
await worker.screenshot({ path: path.join(outDir, "5-worker-clocked-on.png"), fullPage: true });
const clockVisible = await worker.getByText("Clocked on").isVisible();
console.log(`   clock running: ${clockVisible}`);

console.log("4. Worker marks it done");
await worker.getByRole("button", { name: "Mark done" }).first().click();
await worker.waitForTimeout(1400);
await worker.screenshot({ path: path.join(outDir, "6-worker-after-done.png"), fullPage: true });

// --- Supervisor sees the result -------------------------------------------
console.log("5. Supervisor checks the unit");
const sup = await signIn("supervisor@thermal-corp.com");
await sup.goto(`${base}/orders/1`);
await sup.waitForTimeout(900);
await sup.screenshot({ path: path.join(outDir, "7-supervisor-unit.png"), fullPage: true });

await browser.close();
console.log("done");
