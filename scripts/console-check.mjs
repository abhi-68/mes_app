import { chromium } from "playwright";
// PLAYWRIGHT_CHROMIUM_PATH lets a sandbox point at a pre-installed browser; on a normal
// machine Playwright resolves its own (run `npx playwright install chromium` once).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);
const page = await browser.newPage();
const problems = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:3000/login");
await page.fill('input[type="email"]', "worker3@thermal-corp.com");
await page.fill('input[type="password"]', "password123");
await page.click('button[type="submit"]');
await page.waitForURL("http://localhost:3000/");
await page.goto("http://localhost:3000/my-station");
await page.waitForTimeout(2500);
console.log(problems.length ? problems.join("\n") : "no console problems");
await browser.close();
