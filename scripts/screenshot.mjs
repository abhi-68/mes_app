import { chromium } from "playwright";
import path from "path";

const outDir = process.argv[2] || "/tmp";
const email = process.argv[3] || "admin@thermal-corp.com";

// PLAYWRIGHT_CHROMIUM_PATH lets a sandbox point at a pre-installed browser; on a normal
// machine Playwright resolves its own (run `npx playwright install chromium` once).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE ERROR:", m.text());
});

await page.goto("http://localhost:3000/login");
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', "password123");
await page.click('button[type="submit"]');
await page.waitForURL("http://localhost:3000/");
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(outDir, "1-overview.png"), fullPage: true });

await page.goto("http://localhost:3000/orders/1");
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(outDir, "2-unit-progress.png"), fullPage: true });

await page.goto("http://localhost:3000/inventory");
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(outDir, "3-inventory.png"), fullPage: true });

await browser.close();
console.log("done");
