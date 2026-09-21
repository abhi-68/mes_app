# The Odoo-replication PRD, measured against what exists

Assessment of the PRD dated 2026-09-15 (built from observation of `wastem.odoo.com`) against
this codebase at commit `057a099` — 6,752 lines, 38 tests.

**Summary: 3 of the 21 feature areas are complete, 7 are partial, 11 do not exist.** The
recommendation at the end is *not* to close all 11.

---

## 1. Line-by-line against the PRD's own matrix

| # | PRD feature area | Here | Detail |
|---|---|---|---|
| 1 | Products & multi-level BoMs | **Complete** | `items`, `bom_lines`; MANUFACTURED components automatically spawn child work orders with their own routing and progress |
| 2 | Kits & variant BoMs | **None** | no variant or attribute model at all |
| 3 | MOs, 1/2/3-step routes | **Partial** | work orders with a full state machine; no pick→produce→store warehouse routing, one stock location |
| 4 | Work Orders + timers | **Complete** | `work_order_tasks`, `time_entries`, live clock, immutable records |
| 5 | Operations & routing | **Complete** | `routing_steps` per product, editable at `/admin/products/[id]` |
| 6 | Work Centers + overview dashboard | **Partial** | `stations` holds name/description/active only — **no capacity, cost/hour, efficiency, or calendar**; no load dashboard |
| 7 | Shop Floor operator app | **Partial** | `/my-station` does the job; no tablet layout, badge/PIN sign-in, worksheets, inline quality, or scanning |
| 8 | Planning — Gantt / Kanban / employee | **None** | no scheduling of any kind; order of work is the sequence number |
| 9 | Master Production Schedule | **None** | no forecasting, no time buckets |
| 10 | Scrap / Unbuild | **Partial** | reason codes, quality events, a scrap disposition in the engine — **no UI**; no unbuild |
| 11 | By-products | **None** | |
| 12 | Lots / serials & traceability | **None** | quantities are tracked, identities are not — we cannot answer "which units got the bad bearings" |
| 13 | Quality — checks, alerts, teams | **Engine only** | produce/inspect/accept/rework/scrap/reject-after-install, 15 tests, **and no screen calls any of it** |
| 14 | Maintenance & equipment | **None** | |
| 15 | PLM / ECO | **None** | revision freezing is specified in `IMPL-SPEC.md`, not built |
| 16 | Subcontracting | **None** | |
| 17 | Barcode & nomenclature | **None** | every action is a mouse click |
| 18 | IoT / hardware | **None** | `api_keys` and an event-source enum exist in the schema; no API route was ever written |
| 19 | OEE & work-order reporting | **Partial** | `/reports` gives average time per step / station / worker, a quality Pareto and recorded hours; **no OEE** — there is no downtime or availability model to compute it from |
| 20 | Production / delays / cost analysis | **None** | no costing anywhere |
| 21 | Access control, chatter, multi-company | **Partial** | three roles, station scoping, append-only `task_events` audit trail; no chatter/followers, no multi-company |

## 2. Two things the PRD does not capture

Worth noting because they cost real effort and do not appear as a row in anyone's feature
matrix:

- **Convergent sub-assembly progress.** Sub-assemblies each carry their own work order and
  progress, rolling up into the parent weighted by expected minutes. This is Thermal Corp's
  actual shape — several parts made in parallel, converging at final assembly.
- **Correctness under retry and contention.** Starting a step twice does not consume material
  twice; two simultaneous transactions cannot both take the last unit. Proven by tests that fail
  when the guards are removed. Most small MRP tools do not survive this test — it is worth
  trying it on Odoo, Katana and MRPeasy while you have them open.

## 3. What replicating the PRD actually costs

The PRD is a fair description of Odoo Manufacturing. That is the problem with it as a build
target.

Odoo's manufacturing suite is roughly twenty years of work by a funded team, and the modules
named here — `mrp`, `mrp_workorder`, `stock`, `quality`, `maintenance`, `plm`, `iot` — run to
hundreds of thousands of lines. This codebase is 6,752. The phasing in §6 of the PRD is sound
engineering order, but its Phase 1 alone (multi-step routes, work centres with capacity and
calendars, lots and serials, scrap and unbuild, a load dashboard) is months of full-time work,
and all five phases is a multi-year program for a team, not a side project.

There is a second problem, and it is the larger one. **Nine months of building toward feature
parity is nine months not spent on the sentence Thermal Corp actually said**: they work on parts
separately, assemble at the end, and nobody tells them what they are waiting on. A general MES
answers that generically, because it has to serve every factory. A custom one can answer it
exactly — and that is the only defensible reason to write one at all.

## 4. The licensing fact that changes the decision

The instance observed is Odoo Online, which is Enterprise. That matters:

- **Odoo Community** (free, open source, self-hostable) includes manufacturing orders, work
  orders, BoMs, variants, scrap, unbuild, split/merge, and quality control points.
- **Odoo Enterprise** (per user, per month) is where the **Shop Floor tablet app**, MPS, OEE
  dashboards, PLM, IoT and Gantt planning live — several of the features the PRD is most
  impressed by.

So "just use Odoo" is not free if the shop-floor app is the part you want. But "extend Odoo
Community" is a real option: you would inherit rows 1, 3, 10, 11, 12, 16 and much of 13 on day
one, and write a module for the convergent-assembly visibility that is the actual problem.

## 5. Three honest paths

**A — Narrow and finish.** Build the six things that answer Thermal Corp's problem and nothing
else: operation dependencies (so a step says *what* it is waiting on, not just that it is not
its turn), the quality UI over the engine that already exists, worksheets at the station, a
supervisor "what is blocked right now" view, station assignment and permissions, and revision
freezing. Roughly six to ten weeks. At the end you have something that solves the stated problem
better than Odoo does, and is missing lots, barcode and scheduling.

**B — Adopt Odoo Community, extend it.** Stop rebuilding the 80% that exists and write a module
for the 20% that does not. You inherit traceability, variants, subcontracting and the reporting
stack. You give up control of the data model and take on Odoo's framework as a dependency. Fastest
route to something a factory could actually run this year.

**C — Build the replica.** Follow the PRD's phasing. It is achievable with a team and a couple of
years. It is not achievable as scoped otherwise, and I would rather say that now than at month
nine.

## 6. The thing that should happen before any of them

Still true, still unaddressed: **nobody has confirmed how Thermal Corp actually builds an air
handler.** The stations, sequence and routings in the seed are inferred from their public
catalog. Deciding between A, B and C without that is choosing a budget before knowing the job.
One real order, its BOM, its traveler, and an hour on the floor with a supervisor would settle
more than another month of building.
