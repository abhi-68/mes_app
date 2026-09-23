/**
 * Build the client demo deck.
 *
 * Starts from an empty factory (`npm run db:setup`), sets a product up, runs one
 * order from the office to the truck, and photographs every screen on the way.
 * Nothing is mocked: each slide is the real app acting on the real database, so
 * the deck cannot drift from what the software does.
 *
 *   npm run db:setup
 *   npm run deck          (with `npm run dev` running)
 *
 * Output: docs/deck/index.html, one file with the images inlined.
 */
import { chromium } from "playwright";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const BASE = process.env.DECK_BASE ?? "http://localhost:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const itemId = async (sku) => (await one(`SELECT id FROM items WHERE sku = $1`, [sku]))?.id;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1340, height: 920 } });

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------
const slides = [];

function chapter(number, title, standfirst) {
  slides.push({ kind: "chapter", number, title, standfirst });
  console.log(`\n${number}  ${title}`);
}

/**
 * Photograph what is on screen.
 *
 * Always a viewport shot. A full-page capture of a long screen shrinks to
 * something nobody can read from the back of a meeting room.
 */
async function shot(caption, opts = {}) {
  if (opts.sel) {
    await page.locator(opts.sel).first().scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -80));
  } else if (opts.to) {
    await page.evaluate((needle) => {
      const el = [...document.querySelectorAll("h1,h2,h3,p,th,td,span")].find((e) =>
        e.textContent.trim().startsWith(needle)
      );
      if (el) el.scrollIntoView({ block: "start" });
      window.scrollBy(0, -90);
    }, opts.to);
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(opts.settle ?? 700);
  const data = await page.screenshot({ type: "jpeg", quality: 84 });
  slides.push({ kind: "shot", caption, data: data.toString("base64") });
  console.log(`   ${caption}`);
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------
async function signIn(who) {
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
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.waitForTimeout(700);
}

async function press(locator, settle = 1500) {
  await locator.click();
  await page.waitForTimeout(settle);
}

async function fillItem({ sku, name, made, uom, opening = 0, reorder = 0, finished = false }) {
  await page.goto(`${BASE}/admin/products`);
  await page.waitForTimeout(900);
  await page.getByLabel("SKU").fill(sku);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Where it comes from").selectOption(made ? "MANUFACTURED" : "PURCHASED");
  await page.getByLabel("Unit").fill(uom);
  await page.getByLabel("Opening stock").fill(String(opening));
  await page.getByLabel("Reorder at").fill(String(reorder));
  if (finished) await page.getByLabel("This is a finished product we sell").check();
}

async function addItem(spec) {
  await fillItem(spec);
  await press(page.getByRole("button", { name: "Add product" }));
  if (!(await itemId(spec.sku))) throw new Error(`${spec.sku} was not created`);
}

async function addStep(dbId, name, station, minutes, instructions) {
  await page.goto(`${BASE}/admin/products/${dbId}`);
  await page.waitForTimeout(800);
  await page.getByLabel("Next step").fill(name);
  await page.getByLabel("Station").selectOption({ label: station });
  await page.getByLabel("Minutes").fill(String(minutes));
  const spec = page.getByLabel("What to do at this step");
  if (instructions && (await spec.count())) await spec.first().fill(instructions);
  await press(page.getByRole("button", { name: "Add step" }));
}

async function addBomLine(parentDbId, componentSku, qty, atStepName) {
  await page.goto(`${BASE}/admin/products/${parentDbId}`);
  await page.waitForTimeout(800);
  await page.getByLabel("Component").selectOption(String(await itemId(componentSku)));
  await page.getByLabel("Qty").fill(String(qty));
  await page.getByLabel("Taken from stock at").selectOption({ label: atStepName });
  await press(page.getByRole("button", { name: "Add", exact: true }));
}

async function fillDelivery({ sku, quantity, heat, batch, where }) {
  await page.goto(`${BASE}/inventory`);
  await page.waitForTimeout(1300);
  await press(page.getByRole("button", { name: "Book a delivery in" }).first(), 900);
  await page.getByLabel("Item").selectOption(String(await itemId(sku)));
  await page.getByLabel(/^Quantity/).fill(String(quantity));
  await page.getByLabel(/Heat number/).fill(heat);
  await page.getByLabel(/Batch number/).fill(batch);
  await page.getByLabel(/Where it sits/).fill(where);
}

const receive = () => press(page.getByRole("button", { name: /^Receive$/ }).first(), 2400);

async function openStationFor(stepName) {
  const row = await one(
    `SELECT t.station_id FROM work_order_tasks t
       JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.name = $1 ORDER BY t.id LIMIT 1`,
    [stepName]
  );
  if (!row?.station_id) throw new Error(`no station for "${stepName}"`);
  await page.goto(`${BASE}/my-station/${row.station_id}`);
  await page.waitForTimeout(1300);
}

const cardFor = (name) => page.locator(`[data-step-card="${name}"]`).first();

/** The next outstanding line on a card, opened ready to scan. */
async function openNextPick(card) {
  const lines = card.locator("li");
  for (let i = 0; i < (await lines.count()); i++) {
    const line = lines.nth(i);
    const take = line.getByRole("button", { name: /^Scan to take \d+$/ });
    if ((await take.count()) === 0) continue;
    // The line reads "Galvanized Steel Sheet, 16ga 12/12 sheet" — the running
    // count has to come off before the name will match an item.
    const itemName = (await line.innerText())
      .split("\n")[0]
      .replace(/\s*\d+\/\d+\b.*$/, "")
      .trim();
    const outstanding = Number((await take.first().innerText()).match(/\d+/)?.[0] ?? 1);
    await press(take.first(), 700);

    // Biggest pallet first, and never ask for more than is on it — one scan is
    // one pallet, exactly as it is on the floor.
    const lot = await one(
      `SELECT l.batch_number, COALESCE(SUM(m.quantity), 0)::int AS remaining
         FROM stock_lots l
         JOIN items i ON i.id = l.item_id
         LEFT JOIN inventory_movements m ON m.lot_id = l.id
        WHERE i.name = $1 AND l.batch_number IS NOT NULL
        GROUP BY l.id, l.batch_number
       HAVING COALESCE(SUM(m.quantity), 0) > 0
        ORDER BY remaining DESC LIMIT 1`,
      [itemName]
    );
    const qty = lot ? Math.min(outstanding, lot.remaining) : outstanding;
    if (lot && qty !== outstanding) {
      await line.getByLabel("How many").first().fill(String(qty));
    }
    return { line, batch: lot?.batch_number ?? null };
  }
  return null;
}

async function takeIt(pick) {
  if (!pick) return;
  if (pick.batch) {
    await pick.line.getByPlaceholder("Scan the batch label").first().fill(pick.batch);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1900);
  } else {
    await press(pick.line.getByRole("button", { name: "No label on it" }).first(), 1900);
  }
}

async function collect(card) {
  for (let guard = 0; guard < 10; guard++) {
    const pick = await openNextPick(card);
    if (!pick) return;
    await takeIt(pick);
  }
  throw new Error("could not collect everything this step needs");
}

async function finish(card) {
  await press(card.getByRole("button", { name: "Stop" }).first(), 700);
  await press(card.getByRole("button", { name: "Job done" }).first(), 2200);
}

/** Take a step from untouched to done, off camera. */
async function runStep(stepName, who) {
  await signIn(who);
  await openStationFor(stepName);
  await collect(cardFor(stepName));
  await press(cardFor(stepName).getByRole("button", { name: /^(Start|Clock on)$/ }).first(), 1600);
  await finish(cardFor(stepName));
}

// ===========================================================================
const SKU = {
  galv: "RAW-GALV-16",
  insul: "RAW-INSUL-2",
  motor: "BUY-MOTOR-5HP",
  frame: "SUB-FRAME-01",
  unit: "CF-3000-H",
};
const ORDER = "WO-1001";

await signIn("admin");

// ===========================================================================
chapter("One", "Raising an order", "What the office types in, and everything built from it.");

await addItem({ sku: SKU.galv, name: "Galvanized Steel Sheet, 16ga", made: false, uom: "sheet", reorder: 30 });
await addItem({ sku: SKU.insul, name: "Panel Insulation, 2in", made: false, uom: "sheet", reorder: 10 });
await addItem({ sku: SKU.motor, name: "Motor, 5 HP TEFC", made: false, uom: "ea", reorder: 4 });
await addItem({ sku: SKU.frame, name: "Welded Casing Frame", made: true, uom: "ea" });

await fillItem({
  sku: SKU.unit,
  name: "CF Series Air Handling Unit, 3000 CFM",
  made: true,
  uom: "ea",
  finished: true,
});
await shot("Each part and product is described once. This one is a unit we sell.", {
  to: "Add a product",
});
await press(page.getByRole("button", { name: "Add product" }));

const frameId = await itemId(SKU.frame);
const unitId = await itemId(SKU.unit);

await addStep(frameId, "Cut frame sections", "Sheet Metal / Cutting", 45, "Cut to 2400 x 1200. Deburr all edges.");
await addStep(frameId, "Weld casing frame", "Frame Fab", 90, "Full seam weld. Check diagonals before tacking.");
await addStep(unitId, "Fit insulated panels", "Panel & Door Fab", 60, "Bond insulation to the inner skin. No gaps at the corners.");
await addStep(unitId, "Fit fan & motor", "Fan & Motor Assembly", 75, "Align sheaves with a straight edge. Belt tension to spec.");
await addStep(unitId, "Test & sign off", "QC / Dispatch", 30, "Run up, log amps on each phase, leak check the drain pan.");

await addBomLine(frameId, SKU.galv, 6, "Cut frame sections");
await addBomLine(unitId, SKU.frame, 1, "Fit insulated panels");
await addBomLine(unitId, SKU.insul, 8, "Fit insulated panels");
await addBomLine(unitId, SKU.motor, 1, "Fit fan & motor");

await page.goto(`${BASE}/admin/products/${unitId}`);
await page.waitForTimeout(1200);
await shot("The steps it travels through, in order, with what to do at each one.");
await shot("And what it is built from. Each part is tied to the step that consumes it.", {
  to: "Component",
});

// Opening deliveries, so everything on the floor carries a label.
await fillDelivery({ sku: SKU.galv, quantity: 40, heat: "HT-51180", batch: "GALV-2609-A", where: "Rack A1" });
await receive();
await fillDelivery({ sku: SKU.motor, quantity: 6, heat: "HT-51204", batch: "MTR-2609-A", where: "Bay 04" });
await receive();
await fillDelivery({ sku: SKU.insul, quantity: 8, heat: "HT-44821", batch: "INS-2609-A", where: "Rack C2" });
await receive();

await page.goto(`${BASE}/orders/new`);
await page.waitForTimeout(1300);
await page.getByLabel("Work order number").fill(ORDER);
await page.getByLabel("Product").selectOption(String(unitId));
await page.getByLabel("Quantity", { exact: true }).fill("2");
await page.getByLabel("Due date").first().fill(new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10));
await page.getByLabel("Size").first().fill("3000 CFM, 2400 x 1200 x 1800 mm");
await page.getByLabel("Material").first().fill("Galvanised, 16ga");
await shot("Raising the order. The drawing that came with the purchase order goes on here too.");
await press(page.getByRole("button", { name: "Create work order" }), 3500);

const order = await one(`SELECT id FROM work_orders WHERE order_number = $1`, [ORDER]);
await page.goto(`${BASE}/orders/${order.id}`);
await page.waitForTimeout(1500);
await shot("The first thing it says is that a part is missing. Nothing can be built until it lands.");
await shot("So it will not promise a finish date. It says how much work there is instead.", {
  to: "Schedule",
});
await shot("One press created five steps and a sub-assembly order of its own.", {
  to: "Sub-assemblies",
});

// ===========================================================================
chapter("Two", "On the floor", "What a worker sees, and what gets recorded while they work.");

await signIn("worker1");
await shot("A worker signs in and picks the machine they are standing at.");

await openStationFor("Cut frame sections");
await shot("Their job: what to build, what to do, and what to fetch before starting.");

const pick = await openNextPick(cardFor("Cut frame sections"));
await shot("Material is never assumed. They scan the label on the pallet they lifted.", {
  sel: '[data-step-card="Cut frame sections"]',
});
await takeIt(pick);
await shot("That scan moves the stock, and ties this heat number to this job for good.", {
  sel: '[data-step-card="Cut frame sections"]',
});

await press(cardFor("Cut frame sections").getByRole("button", { name: /^(Start|Clock on)$/ }).first(), 1600);
await shot("Only now will the clock start. With the steel still on the rack, it would not.", {
  sel: '[data-step-card="Cut frame sections"]',
});

await press(cardFor("Cut frame sections").getByRole("button", { name: "Scrap", exact: true }).first(), 900);
await shot("One is cut wrong. Scrap is two presses, and it asks why.", {
  sel: '[data-step-card="Cut frame sections"]',
});
await press(cardFor("Cut frame sections").getByRole("button", { name: "Dimension out of spec" }).first(), 2400);
await shot("The steel is written off against that reason, and the job asks for a replacement.", {
  sel: '[data-step-card="Cut frame sections"]',
});

await collect(cardFor("Cut frame sections"));
await finish(cardFor("Cut frame sections"));
await shot("Signed off, and still reachable for the rest of the shift in case of a mistake.", {
  to: "Finished here today",
});

await signIn("supervisor");
await page.goto(`${BASE}/timesheets`);
await page.waitForTimeout(1700);
await shot("Nobody filled a timesheet in. Clock time and time charged to the job stay apart.");

await page.goto(`${BASE}/quality`);
await page.waitForTimeout(1700);
await shot("Every write-off lands here with its reason, its quantity, and who recorded it.");

// ===========================================================================
chapter("Three", "Stock", "Where material comes from, where it goes, and when to buy more.");

await signIn("admin");
await page.goto(`${BASE}/inventory`);
await page.waitForTimeout(1700);
await shot("What is on the racks, what is free, and what is already promised to jobs.");
await shot("Every batch carries its own barcode, its heat number, and where it sits.", {
  to: "Batch number",
});

await fillDelivery({ sku: SKU.insul, quantity: 24, heat: "HT-44822", batch: "INS-2609-B", where: "Rack C2" });
await shot("Booking the late insulation in. The heat number is what makes it traceable.");
await receive();
await shot("The label prints straight away. That barcode is what the floor scans.");

await page.goto(`${BASE}/orders/${order.id}`);
await page.waitForTimeout(1700);
await shot("The shortage cleared itself, and the order now has a date it can stand behind.");

// ===========================================================================
chapter("Four", "Being told", "Nobody should have to go looking for a problem.");

await signIn("supervisor");
await openStationFor("Weld casing frame");
await press(cardFor("Weld casing frame").getByRole("button", { name: "Give to someone" }).first(), 900);
await shot("A supervisor puts a name on a job, at the machine, without a dropdown.", {
  sel: '[data-step-card="Weld casing frame"]',
});
// Whoever we hand it to has to be whoever we sign in as next, or the slide that
// follows proves nothing.
const handTo = await one(`SELECT name FROM users WHERE email = 'worker2@thermal-corp.com'`);
await press(
  cardFor("Weld casing frame").getByRole("button", { name: handTo.name, exact: true }).first(),
  2400
);

await signIn("worker2");
await shot("That person is told by name, on the first screen they see.");
await page.goto(`${BASE}/alerts`);
await page.waitForTimeout(1700);
await shot("Their alerts. Only what concerns them, not the whole floor.");

await signIn("supervisor");
await page.goto(`${BASE}/alerts`);
await page.waitForTimeout(1700);
await shot("A supervisor's: work that can now start, and steel to reorder before it runs out.");

await page.goto(`${BASE}/waiting`);
await page.waitForTimeout(1700);
await shot("And the question this whole thing exists to answer: what is held up, and on what.");

// ===========================================================================
chapter("Five", "Out of the door", "A finished unit becomes stock, and stock goes on a truck.");

await runStep("Weld casing frame", "worker2");
await runStep("Fit insulated panels", "worker3");
await runStep("Fit fan & motor", "worker4");
await runStep("Test & sign off", "worker1");

await signIn("supervisor");
await page.goto(`${BASE}/orders/${order.id}`);
await page.waitForTimeout(1700);
await shot("Every step signed off by the person who did it, with what it actually took.", {
  to: "Final assembly",
});

await page.goto(`${BASE}/stock`);
await page.waitForTimeout(1700);
await shot("Signing off the last step puts the unit on the rack, under its own order number.");

await signIn("forklift");
await page.goto(`${BASE}/loading`);
await page.waitForTimeout(1700);
await shot("The driver's screen: built, and waiting for a truck.");
const load = page.getByRole("button", { name: "Loaded" }).first();
if (await load.count()) {
  await press(load, 900);
  await press(page.getByRole("button", { name: "Yes, loaded" }).first(), 2600);
  await shot("One press raises the delivery note and takes it off the rack.");
}

await signIn("supervisor");
await page.goto(`${BASE}/orders`);
await page.waitForTimeout(1700);
await shot("And the office can see it has gone, without ringing anyone to ask.");

await sql.end();
await browser.close();

// ---------------------------------------------------------------------------
const out = path.join(process.cwd(), "docs", "deck");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), render(slides));
const kb = Math.round(fs.statSync(path.join(out, "index.html")).size / 1024);
console.log(`\ndocs/deck/index.html  ${slides.length} slides, ${kb} KB`);

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(all) {
  const body = all
    .map((s) =>
      s.kind === "chapter"
        ? `<section class="slide chapter">
             <p class="num">${esc(s.number)}</p>
             <h2>${esc(s.title)}</h2>
             <p class="stand">${esc(s.standfirst)}</p>
           </section>`
        : `<section class="slide">
             <p class="cap">${esc(s.caption)}</p>
             <img src="data:image/jpeg;base64,${s.data}" alt="${esc(s.caption)}">
           </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thermal Corp — how it works</title>
<style>
  :root { --g50:#f8f9fa; --g200:#e6e8eb; --g400:#9aa1a9; --g500:#6b7280; --g900:#16181d; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--g50); color:var(--g900);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .slide { display:none; height:100vh; padding:26px 36px 54px;
           flex-direction:column; align-items:center; }
  .slide.on { display:flex; }
  .cap { margin:0 0 14px; font-size:20px; font-weight:600; text-align:center;
         max-width:1000px; letter-spacing:-.01em; }
  img { max-width:100%; max-height:calc(100vh - 124px); object-fit:contain;
        border:1px solid var(--g200); border-radius:10px; background:#fff; }
  .chapter { justify-content:center; }
  .chapter .num { margin:0; font-size:12px; font-weight:500; letter-spacing:.1em;
                  text-transform:uppercase; color:var(--g400); }
  .chapter h2 { margin:10px 0 0; font-size:46px; font-weight:600; letter-spacing:-.025em; }
  .chapter .stand { margin:14px 0 0; font-size:18px; color:var(--g500);
                    max-width:600px; text-align:center; }
  footer { position:fixed; left:0; right:0; bottom:0; height:42px;
           display:flex; align-items:center; justify-content:space-between;
           padding:0 18px; border-top:1px solid var(--g200); background:#fff;
           font-size:12px; color:var(--g500); }
  button { min-height:26px; padding:0 11px; border:1px solid var(--g200); border-radius:6px;
           background:#fff; color:var(--g900); font:inherit; font-size:12px; cursor:pointer; }
  button:hover { background:var(--g50); }
  @media print { .slide { display:flex; height:auto; page-break-after:always; } footer { display:none; } }
</style></head><body>
${body}
<footer>
  <span>Thermal Corp MES</span>
  <span><button id="prev">&larr;</button> <span id="pos"></span> <button id="next">&rarr;</button></span>
</footer>
<script>
  const slides = [...document.querySelectorAll('.slide')];
  let i = 0;
  function go(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, k) => s.classList.toggle('on', k === i));
    document.getElementById('pos').textContent = (i + 1) + ' / ' + slides.length;
    history.replaceState(null, '', '#' + i);
  }
  document.getElementById('next').onclick = () => go(i + 1);
  document.getElementById('prev').onclick = () => go(i - 1);
  addEventListener('keydown', (e) => {
    if (['ArrowRight',' ','PageDown'].includes(e.key)) go(i + 1);
    if (['ArrowLeft','PageUp'].includes(e.key)) go(i - 1);
    if (e.key === 'Home') go(0);
    if (e.key === 'End') go(slides.length - 1);
  });
  go(Number(location.hash.slice(1)) || 0);
</script>
</body></html>`;
}
