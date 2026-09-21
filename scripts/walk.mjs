/**
 * Walk every screen as every role and report what is broken.
 *
 * Not a test — a sweep. It signs in as each of the six demo accounts, visits
 * every page that role can reach, and records HTTP failures, console errors,
 * React hydration warnings, empty main regions and any tap target smaller than
 * 44 x 44 CSS pixels. Screenshots go in the output directory so the layout can
 * be looked at rather than guessed about.
 *
 * The touch-target check is deliberate: this runs on tablets on a shop floor,
 * and a control that a gloved hand cannot reliably hit is a defect even though
 * nothing about it throws.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || "/tmp/walk";
const BASE = "http://localhost:3000";
const MIN_TARGET = 44;

fs.mkdirSync(outDir, { recursive: true });

const ROLES = [
  {
    email: "worker1@thermal-corp.com",
    label: "worker",
    pages: ["/", "/alerts", "/floor", "/floor/4", "/my-station", "/my-station/7", "/orders", "/orders/:order", "/orders/:order/report", "/inventory", "/materials", "/timesheets"],
  },
  {
    email: "supervisor@thermal-corp.com",
    label: "supervisor",
    pages: [
      "/",
      "/alerts",
      "/floor", "/floor/4",
      "/orders",
      "/orders/:order", "/orders/:order/report",
      "/inventory",
      "/materials",
      "/timesheets",
      "/quality",
      "/delivery-notes",
      "/waiting",
      "/reports",
    ],
  },
  {
    email: "admin@thermal-corp.com",
    label: "admin",
    pages: [
      "/",
      "/alerts",
      "/floor", "/floor/4",
      "/orders",
      "/orders/:order", "/orders/:order/report",
      "/inventory",
      "/materials",
      "/timesheets",
      "/quality",
      "/delivery-notes",
      "/waiting",
      "/reports",
      "/admin",
      "/admin/people",
      "/admin/products",
      "/admin/reason-codes",
      "/orders/new",
    ],
  },
];

const problems = [];
/** Resolved from the first role's order list: an id, or null when the floor is empty. */
let orderId;
const note = (role, page, kind, detail) => {
  problems.push({ role, page, kind, detail });
  console.log(`  ${kind.padEnd(16)} ${page}  ${detail}`);
};

// PLAYWRIGHT_CHROMIUM_PATH lets a sandbox point at a pre-installed browser; on a normal
// machine Playwright resolves its own (run `npx playwright install chromium` once).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}
);

for (const role of ROLES) {
  console.log(`\n=== ${role.label} (${role.email}) ===`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" || /hydrat|Warning: |unique "key"/i.test(text)) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', role.email);
  await page.fill('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });

  // The order routes are only meaningful when there is an order. On a clean
  // floor there is not, and a hardcoded /orders/1 would report a 404 that says
  // nothing about the app. Resolve a real one, or leave those routes out.
  if (orderId === undefined) {
    await page.goto(`${BASE}/orders`, { waitUntil: "networkidle" });
    const href = await page
      .locator('a[href^="/orders/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    orderId = /^\/orders\/(\d+)/.exec(href ?? "")?.[1] ?? null;
    if (orderId === null) console.log("  (no orders on the floor - skipping order pages)");
  }

  const routes = role.pages
    .filter((r) => orderId !== null || !r.includes(":order"))
    .map((r) => r.replace(":order", String(orderId)));

  for (const route of routes) {
    consoleErrors.length = 0;
    const res = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    const status = res?.status() ?? 0;
    if (status >= 400) {
      note(role.label, route, "HTTP", String(status));
      continue;
    }
    await page.waitForTimeout(350);

    // Did anything actually render?
    const bodyText = (await page.locator("body").innerText()).trim();
    if (bodyText.length < 80) {
      note(role.label, route, "EMPTY", `${bodyText.length} chars of text`);
    }
    if (/Application error|Unhandled Runtime|This page could not be found/i.test(bodyText)) {
      note(role.label, route, "ERROR PAGE", bodyText.slice(0, 120).replace(/\s+/g, " "));
    }

    for (const err of consoleErrors) {
      note(role.label, route, "CONSOLE", err.slice(0, 160).replace(/\s+/g, " "));
    }

    // Touch targets. Only visible, enabled interactive elements count.
    const small = await page.evaluate((min) => {
      const out = [];
      const nodes = document.querySelectorAll(
        "button:not([disabled]), a[href], select, input:not([type=hidden])"
      );
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        // Inline links inside a sentence are not tap targets in the same sense;
        // they are excluded so the signal is about controls.
        if (el.tagName === "A" && el.closest("p") && el.textContent.length < 40) continue;
        if (r.height < min || r.width < min) {
          out.push(
            `${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 28)}" ${Math.round(r.width)}x${Math.round(r.height)}`
          );
        }
      }
      return out.slice(0, 6);
    }, MIN_TARGET);
    for (const s of small) note(role.label, route, "SMALL TARGET", s);

    const name = `${role.label}${route.replace(/\//g, "_") || "_home"}.png`;
    await page.screenshot({ path: path.join(outDir, name), fullPage: true });
  }

  await context.close();
}

await browser.close();

console.log(`\n--- ${problems.length} problems found ---`);
const byKind = {};
for (const p of problems) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
for (const [kind, n] of Object.entries(byKind)) console.log(`${String(n).padStart(4)}  ${kind}`);
fs.writeFileSync(path.join(outDir, "problems.json"), JSON.stringify(problems, null, 2));
console.log(`screenshots + problems.json in ${outDir}`);
