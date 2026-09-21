/**
 * Do the labels on the screen actually scan?
 *
 * The unit tests prove the ENCODER is right. They cannot prove the page draws what
 * the encoder produced — a wrong `x`, a rounded width, a missing white ground, and
 * the bars are subtly wrong in a way no test of pure functions would ever see. So
 * this opens the real inventory page in a real browser, reads the rectangles that
 * were actually painted, reconstructs the module-width sequence from their geometry,
 * and compares it to the encoder.
 *
 * Run it with the dev server up:  npx tsx scripts/verify-labels.mts
 */
import { chromium } from "playwright";

// PLAYWRIGHT_CHROMIUM_PATH lets a sandbox point at a pre-installed browser; on a normal
// machine Playwright resolves its own (run `npx playwright install chromium` once).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);
const page = await browser.newPage();
// A cold Turbopack dev server compiles each route on first hit, which can take
// well past the default five seconds. Generous timeouts here rather than a flaky
// script that fails for a reason that has nothing to do with the barcodes.
page.setDefaultTimeout(90_000);
page.setDefaultNavigationTimeout(90_000);

await page.goto("http://localhost:3000/login");
await page.fill('input[type="email"]', "admin@thermal-corp.com");
await page.fill('input[type="password"]', "password123");
await page.click('button[type="submit"]');
await page.waitForURL("http://localhost:3000/", { timeout: 90_000 });
await page.goto("http://localhost:3000/inventory", { waitUntil: "networkidle" });
await page.waitForSelector("[data-lot-batch]", { timeout: 90_000 });

const found = await page.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll("[data-lot-batch]")) {
    const code = row.getAttribute("data-lot-batch");
    const svg = row.querySelector("svg");
    if (!code || !svg) continue;
    const rects = [...svg.querySelectorAll("rect")];
    const ground = rects[0];
    const bars = rects.slice(1).map((r) => ({
      x: Number(r.getAttribute("x")),
      w: Number(r.getAttribute("width")),
    }));
    out.push({ code, total: Number(ground.getAttribute("width")), bars });
  }
  return out;
});

let checked = 0;
let failed = 0;
for (const { code, total, bars } of found) {
  // Rebuild the alternating bar/space module sequence from the painted rectangles.
  const moduleWidth = Math.min(...bars.map((b) => b.w));
  const quiet = bars[0].x;
  const widths = [];
  let cursor = quiet;
  for (const bar of bars) {
    if (bar.x > cursor) widths.push((bar.x - cursor) / moduleWidth); // the space before it
    widths.push(bar.w / moduleWidth);
    cursor = bar.x + bar.w;
  }
  const { code128Widths } = await import("../src/lib/code128.ts");
  const ours = code128Widths(code);
  if (!ours) {
    console.log(`FAIL ${code}  the encoder refused this code outright`);
    failed++;
    continue;
  }
  const same = JSON.stringify(ours) === JSON.stringify(widths);
  console.log(`${same ? "OK  " : "FAIL"} ${code}  painted=${widths.length} encoded=${ours.length} quiet=${quiet / moduleWidth} total=${total / moduleWidth}`);
  if (!same) console.log("  painted", widths.join(","), "\n  encoded", ours.join(","));
  if (!same) failed++;
  checked++;
}

console.log(`\n${checked} labels checked, ${failed} wrong`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
