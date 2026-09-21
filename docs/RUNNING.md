# Running it on your own machine

The setup used to be Linux-only — it shelled out to `sudo -u postgres psql` and
`pg_ctlcluster`, neither of which exists on Windows. That has been replaced with Node scripts
that talk to PostgreSQL over the network, so the same three commands work on Windows, macOS and
Linux.

Verified on Linux from a cold start on 2026-09-16: database dropped and rebuilt, dev server
started, 113/113 tests, the 67-check simulation, the barcode check and the screen sweep
all run clean. The
Windows path uses the same scripts; the only untested part is your Postgres install, which
is why §1 covers it.

---

## 1. Install the two prerequisites

**Node 22 or newer** — https://nodejs.org (the LTS installer). Check with `node -v`.

**PostgreSQL 16.** Two options; either is fine.

*Installer* — https://www.postgresql.org/download/windows/. During setup it asks for a password
for the `postgres` user. **If you set anything other than `postgres`, you must edit `.env`
afterwards** (step 2). Leave the port at 5432.

*Docker* — one command, nothing installed on the machine:

```
docker run -d --name mes-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
```

Start it again later with `docker start mes-pg`.

## 2. Set it up

Open a terminal (PowerShell, Command Prompt or Git Bash) in the project folder:

```
npm install
npm run db:setup
```

`db:setup` writes a `.env` if there isn't one (with a freshly generated `AUTH_SECRET`), drops
and recreates the `mes_dev` database, pushes the schema, applies `src/db/constraints.sql`, and
seeds the demo data. It prints the logins when it finishes.

If your Postgres password is not `postgres`, the first run creates `.env` and then fails to
connect. Edit the line in `.env`:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/mes_dev"
```

and run `npm run db:setup` again.

Two things this script exists to stop you hitting:

- **The CHECK constraints are not in the Drizzle schema.** `db:push` alone leaves the database
  without `on_hand >= 0` and the other invariant backstops.
- **The seed inserts, it does not upsert.** Running `npm run db:seed` twice fails on the
  `users_email_idx` unique index. `npm run db:setup` is how you start over — run it whenever the
  data gets into a state you don't want.

## 3. Start it

```
npm run dev
```

Open http://localhost:3000. Password for every demo account is `password123`.

| Login | Role | Sees |
|---|---|---|
| `admin@thermal-corp.com` | ADMIN | everything, plus `/admin` — people, products, routings, BOMs, reason codes, work-order release |
| `supervisor@thermal-corp.com` | SUPERVISOR | Final Assembly; can act on any station's steps, view timesheets |
| `worker1@thermal-corp.com` | WORKER | Frame Fab |
| `worker2@thermal-corp.com` | WORKER | Coil Line |
| `worker3@thermal-corp.com` | WORKER | Fan & Motor Assembly — **start here**, its steps consume material |
| `worker4@thermal-corp.com` | WORKER | Final Assembly |

### A ten-minute tour that shows what actually works

Sign in as `worker3@`:

1. **`/my-station`** — steps queued for Fan & Motor Assembly. Tap **Start** on the first ready
   one. The clock starts and a fan wheel leaves stock, in the same database transaction.
2. **`/inventory`** — that fan wheel's on-hand is one lower, with an ISSUE movement row behind
   it. `src/lib/inventory.ts` is the only code in the system that can write that number.
3. Tap **Start** again on the same step, or reload and retry — it does **not** consume a second
   wheel. That is the defect this whole engine exists to prevent; it used to drive stock to -3.
4. **`/orders`** then a unit — the progress tree. Sub-assembly work orders roll up into the
   parent weighted by expected minutes, so a long step counts for more than a short one.
5. Sign in as `supervisor@` → **`/timesheets`**. Labour came from the worker's clock. The worker
   cannot edit it; corrections are separate, audited rows.
6. Sign in as `admin@` → **`/admin/products`** → a product. This is the routing and BOM that
   generated those steps, including which step consumes which component. Change it and release a
   new work order from `/admin/work-orders` to see a different process come out.

Every screen: `/`, `/my-station`, `/orders`, `/orders/[id]`, `/inventory`, `/reports`,
`/timesheets`, `/admin`, `/admin/people`, `/admin/products`, `/admin/products/[id]`,
`/admin/reason-codes`, `/admin/work-orders`.

## 4. Run the tests

```
npm run test:setup   # drops and recreates mes_test
npm test
```

Expected last line:

```
total 113  pass 113  fail 0
```

Two deliberate safety properties:

- **The suite always uses `mes_test`**, taking only the host and password from your `.env`.
  Every test file truncates every table, so it must never touch `mes_dev`.
- **One process per test file, sequentially** (`scripts/run-tests.mjs`). Two files sharing a
  process stomped each other's fixtures — a real failure, not a precaution.

The runner prints a line per file as it goes, so a file that crashed before reporting
anything is not mistaken for one with few tests:

```
✓ tests/alerts.test.ts           14/14
✓ tests/assign.test.mts          13/13
✓ tests/code128.test.ts          7/7
✓ tests/concurrency.test.ts      2/2
✓ tests/dependencies.test.ts     14/14
✓ tests/inventory.test.ts        12/12
✓ tests/lots.test.ts             13/13
✓ tests/outputs.test.ts          15/15
✓ tests/task-action.test.mts     12/12
✓ tests/timesheets.test.ts       11/11
```

`docs/CUTOVER-EVIDENCE.md` §5 names the original set.

Run one file on its own through the runner rather than by hand — every file truncates every
table, so two running at once will fail each other.

One file on its own:

```
node --import tsx --experimental-test-module-mocks --test tests/inventory.test.ts
```

(with `DATABASE_URL` pointing at `mes_test`). The `--experimental-test-module-mocks` flag is
needed by `tests/task-action.test.mts`, which mocks the session module — also why that file is
`.mts`.

### Checking the tests have teeth

A green suite only means something if breaking the code turns it red. Cheapest check: delete
`.for("update")` from `src/lib/inventory.ts` and run `tests/concurrency.test.ts` — it must fail.
`docs/CUTOVER-EVIDENCE.md` §7 lists nine such defects with the tests each should break.

## 5. The scripted browser demo (optional)

With `npm run dev` running, in a second terminal:

```
npx playwright install chromium    # once
node scripts/demo-cutover.mjs ./out
```

It drives the real UI and queries the database between steps:

```
1. Worker signs in at Fan & Motor Assembly
   fan wheels on hand before: 4, issue movements: 0
2. Worker taps Start on the first ready step
   fan wheels on hand after:  3, issue movements: 1
   -> consumed 1, wrote 1 issue movement(s)
3. Worker marks the first step done
4. Emptying stock of the motor the NEXT step needs
5. Worker taps Start on the step whose motor is gone
   message shown to the worker: "Short 1 of the material this step needs"
   step status before: PENDING, after: PENDING
   motor stock: 0 (nothing drawn)
```

Screenshots land in `./out`. **It mutates `mes_dev`** — step 4 zeroes a motor's stock — so run
`npm run db:setup` afterwards.

## 5b. The full simulation, and the screen sweep

Two things worth running before showing the app to anyone.

```
npm run simulate        # 67 checks: every role, a whole job, through the real UI
npm run walk ./out      # every page as every role — errors, empty screens, tap targets
npm run verify:labels   # do the barcodes on the screen actually encode what they claim
```

**`npm run simulate`** creates a product nobody has made before, defines its process and
its parts, releases an order, and then drives four workers, a supervisor and an admin
through building it — including a sub-assembly handoff, a blocker raised and cleared, a
material shortage, a step handed to a named person, and one worker clocked on to two jobs
at once. It asserts against the database between steps, not against the screen. It
mutates `mes_dev`; run `npm run db:setup` afterwards. If Playwright cannot find a browser,
set `PLAYWRIGHT_CHROMIUM_PATH` to a Chromium binary.

**`npm run walk`** signs in as each of the six demo accounts, visits every page that role
can reach, and reports HTTP failures, console errors, React warnings, empty pages, and any
control smaller than 44 × 44 CSS pixels — the W3C enhanced target size, which matters
because this runs on tablets on a shop floor. Screenshots and a `problems.json` land in the
output directory. It reads only; it does not mutate anything.

**`npm run verify:labels`** opens the inventory page in a real browser, reads the
rectangles actually painted into each barcode SVG, reconstructs the module widths from
their geometry and compares them to the encoder. The unit tests prove the encoder is
right; only this proves the page draws what the encoder produced. It reads only.

The expected result today is 67 passed / 0 failed from the simulation, and from the walk
only small-target findings — "Correct", "Retire" and "Deactivate" at 36 px on dense admin
tables, plus one 24 px checkbox whose label row is 44 px. Those are listed under "Known
and accepted" in `docs/RELEASE-PLAN.md`. An HTTP failure, a console error, an empty page,
or a small target anywhere else is new and should be fixed rather than accepted.

## 6. Other commands

```
npm run build          # production build
npm run lint
npx tsc --noEmit       # type check
npm run db:studio      # browse the tables in a UI
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cannot reach PostgreSQL at localhost:5432` | server not running, or wrong password | start the `postgresql-x64-16` service (Windows) or `docker start mes-pg`; check the password in `.env` |
| Seed fails on `users_email_idx` | already seeded; the seed inserts, not upserts | `npm run db:setup` |
| `DROP DATABASE` hangs or errors | something is connected to `mes_dev` | the script force-closes sessions; if it persists, stop `npm run dev` and retry |
| Port 3000 in use | something else is on it | `npm run dev -- -p 3001` |
| `tsx`/`drizzle-kit` not found | dependencies not installed | `npm install` |
| Playwright cannot find a browser | browser not downloaded | `npx playwright install chromium` |

## What you are *not* looking at

The station list, routing and assembly sequence in the seed are **a best guess from Thermal
Corp's public catalog**, not their real process. The mechanism is real and tested; the factory
model behind the demo data is not validated. `docs/STATUS.md` lists what is built and what is
not.
