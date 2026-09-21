# Status — what is built, what is not

Updated 2026-09-16. **93 tests passing**, a **59-check end-to-end simulation** driving the
real UI as all six roles, a clean production build, and a screen-by-screen sweep
(`npm run walk`, `scripts/walk.mjs`) across 30 role/page combinations with no HTTP errors,
no console errors and no empty pages.

**It is a prototype with a tested core and a factory model that is still a guess.** The
one thing Thermal Corp actually asked for — knowing what you are waiting on — works.

**`docs/RELEASE-PLAN.md` is the backlog.** It maps the eight-section release brief onto
this codebase: what exists, what is built in the engine but unreachable from the UI, what
is not started, and the order to do it in. Read that for the plan; read this for the
summary.

---

## New on 2026-09-16

| Change | Why it mattered |
|---|---|
| **Supervisors can hand a step to a named person** | A station says *where* work happens; it cannot say *who*. Epicor's own customers have an open enhancement request for exactly this. The person is told by name, and only them. 13 tests. |
| **Concurrent clock-ons prorate** | One operator minding three machines recorded three hours per hour, and every average and cost built on that was wrong in the same direction with nothing on screen to say so. Timesheets now show **on the clock** and **charged to the job** separately. 11 tests. |
| **Three role home screens** | `/` was one plant overview for everyone and answered nobody's first question. `src/lib/home.ts`. |
| **Setup-gap detection** | The admin home names configuration that will fail later *on the floor* and says what each gap will break. Found four real gaps in our own seed on first run. |
| **44 px tap targets** | Measured by `scripts/walk.mjs`, not judged by eye. Everything used on the floor clears the W3C enhanced target size. |

Three defects surfaced, all by tests or measurement rather than by reading: charged time
could exceed clocked time where a recorded duration disagreed with its timestamps; a
blocker with no event read "stopped 0m ago"; a negative duration propagated into totals as
a silent subtraction.

---

## New in the dependency work (2026-09-15)

| Change | Why it mattered |
|---|---|
| **Operation dependencies** replace sequence gating | A sequence number could not express "final assembly waits on the fan section". Dependencies can, so convergent assembly is modelled rather than implied |
| **"What's waiting" screen** | Every step that cannot start and why, for the whole floor. Separates 8 genuinely held up from 19 merely queued behind their own predecessor |
| **Blockers on every task card** | A worker sees "Short 1 unit of Welded Casing Frame — 'Fit base rail & lifting lugs' on WO-1001-01", not a greyed-out button |
| **The guard moved to the server** | Out-of-turn starts were previously prevented only by a disabled button in the browser |
| **`holdOutput` / `releaseOutputHold`** | `operation_outputs.heldQty` was a column no command ever wrote, so QUALITY_ACCEPTANCE could never have fired |
| **Deployable to a hosted link** | Managed-Postgres seeding, proxy-aware auth, a demonstration banner |

Two real defects surfaced while building it, both by tests rather than by reading:

- A component supplied by a sub-assembly was reported twice — once as a dependency and
  again as a stock shortage that no receipt could ever clear.
- Reclassifying the routing chain as SEQUENCE silently disabled the new server guard,
  because the guard filtered on kind. The integration test caught it the same minute.

## Built and tested

| Area | Evidence |
|---|---|
| Operation dependencies — full completion, required quantity, quality acceptance | 14 tests; created at release from routing and BOM; enforced in the action, not just the UI |
| "What's waiting" — the floor-wide answer | `waitingOperations()`, tested; the screen the project exists for |
| Inventory engine — receive, reserve, issue, return, hold, release, reconcile | 12 tests; single write path; row locks; DB CHECK constraints |
| Command idempotency and concurrency | replay applies once; two overlapping transactions cannot both take the last unit, and that test fails if the locks are removed |
| Output dispositions — produce, inspect, allocate, install, return, reject, hold | 15 tests |
| Task actions in one transaction with material issue | 11 integration tests |
| Hierarchical work orders, progress weighted by expected minutes | `/orders/[id]` |
| Per-product routings and BOMs, editable | `/admin/products/[id]` |
| Immutable timesheets with audited corrections | workers cannot edit |
| Worker / supervisor / admin screens | 15 pages |

## Specified, not built

1. **Revision freezing at release.** Editing a BOM or routing still affects orders
   already on the floor.
2. **Scoped permissions and multi-station assignment.** `users.stationId` is one column;
   a worker who covers two stations cannot be modelled.
3. **Time-correction request and approve, with no self-approval.**
4. **SPECIFIC_UNIT dependencies.** Deliberately left out of the enum — it needs lot and
   serial identity, and a dependency type that can never be satisfied is worse than one
   that does not exist.

## Not started

5. **The quality engine has no UI.** Produce, inspect, accept, rework, scrap, hold —
   all built, all tested, and no screen calls any of it. The dependency engine reads it,
   so a hold set in the database blocks the parent correctly; nobody can set one from the
   app.
6. **Work instructions at the station.** The `attachments` table is read and written by
   nothing.
7. **Event-ingestion API** for scanners, PLCs and vision. Nothing under `src/app/api/`
   except auth.
8. **Lot and serial traceability, barcode input, scheduling and capacity, purchasing,
   costing, OEE.** See `docs/PRD-GAP-ANALYSIS.md` for how these line up against a
   commercial MES.

## The real blocker, unchanged

**Nobody has confirmed how Thermal Corp actually builds an air handler.** The stations,
the sequence and the routings come from their public catalogue. The software treats
routings as data, so correcting them is configuration rather than code — but no readiness
claim can be made about a factory model nobody has checked.

`docs/DEMO-SCRIPT.md` is built around fixing exactly that: show them the guess, and let
them correct it.

## Next

1. Deploy the link (`docs/DEPLOY.md`), run the demo (`docs/DEMO-SCRIPT.md`).
2. Come back with their traveler and one real order.
3. Then: their real routing in the seed, the quality UI, work instructions at the
   station, and whichever gaps they actually named — in that order.
