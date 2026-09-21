# Release plan — from prototype to sellable

Written 2026-09-16 against the eight-section brief. This is the backlog we work down.
Each row says what exists, what does not, and — where it matters — why the gap is worse
than it looks.

**The sellable promise, stated once:** *Thermal Corp can track orders and sub-assemblies,
see what is blocking each one, control materials, and capture labour records that stand
up.* Everything below is judged against whether the first release demonstrates that
reliably, not against whether it is feature-complete.

Current state: **93 unit and integration tests**, a **59-check end-to-end simulation**
that drives the real UI as all six roles, a clean production build, and a screen-by-screen
sweep (`scripts/walk.mjs`) reporting no HTTP errors, no console errors and no empty pages
across 30 role/page combinations.

---

## What landed today

| Change | Why |
|---|---|
| **Supervisors can hand a step to a named person** | The single loudest complaint from Epicor's own customers is that they cannot do this from the main application. One column, one guard, one alert. See `docs/epicor.html`. |
| **Concurrent clock-ons prorate** | One operator minding three machines was recording three hours per hour. Every average, estimate and cost built on that was wrong in the same direction, invisibly. `src/lib/timesheets.ts`, 11 tests. |
| **Three role home screens** | `/` was one plant overview for everyone and answered nobody's first question. Worker: what do I pick up. Supervisor: what is stuck and who is free. Admin: what is not set up and what is waiting on me. |
| **Tap targets to 44 CSS px** | Every primary control and every navigation item. Verified by automated measurement, not by eye. |
| **Setup-gap detection** | The admin home names configuration that will fail *later, on the floor* — products with no routing, workers with no station, bought parts with no reorder point — and says what each will break. It found four real gaps in our own seed on first run. |

### Two defects the work surfaced

- **Charged time could exceed clocked time.** Proration originally computed from
  timestamps while the clock column came from the recorded duration. Where the two
  disagreed — imported history, seeded data — the timesheet showed a step charged with
  more time than it was open for. Fixed by computing a *fraction* from the timestamps and
  applying it to the recorded duration, so with nothing overlapping the columns match to
  the second. Regression test P11.
- **A blocker with no event showed as "stopped 0m ago".** Supervisors triage on age, so a
  confident wrong age is worse than no age. Now null, displayed as nothing, sorted last.

---

## §1 Role home screens — **done, with one gap**

| Role | Sees first | Status |
|---|---|---|
| Worker | Running now → yours by name → ready at your station → what is not ready and why | Done |
| Supervisor | Blocked (oldest first, with who raised it and how long ago) → overrunning → station workload with who is on shift | Done |
| Admin | Orders awaiting release → setup gaps → stock exceptions | Done |

Plant-wide order lookup stays open to every role at `/orders`.

**Gap:** the worker home links to `/my-station` for the actions rather than carrying Start
on the card. Deliberate — one screen where work is started and stopped, because two places
to tap Start is how a step gets begun twice — but worth revisiting on a real tablet.

**Not done from this section:** "report quantity", "view drawing" and "request help" are
listed as worker actions and none exist. They belong to §3.

## §2 The task screen — **partly done**

| Shown today | Missing |
|---|---|
| Order number, product, sub-assembly | Quantity on the step |
| Prerequisites and the exact reason it cannot start | Approved drawing / instruction revision |
| Who is clocked on, and when time is being shared | Required materials and their issue status, per line |
| Status with text alongside colour, 44px controls | Produced / accepted / scrapped / remaining |

**Clock me off vs pause the operation** is the one design decision still open. Today
"Clock off" ends *your* labour session and leaves the step running for whoever else is on
it, which is correct as far as it goes — but there is no way to say *the work itself has
stopped* short of flagging it blocked. Those are different facts and a supervisor needs
both.

**Completing is still an unqualified button.** It should ask for quantity produced,
quantity accepted and scrap before it will close the step. That is the single
highest-value item in this section and it depends on §3.

## §3 Missing operational screens — **the biggest section, mostly unreachable engine**

This is where the brief's sharpest line applies: *a tested engine function that nobody can
reach through the app is still an unfinished customer workflow.* Every row marked
"engine only" below is built, tested, and callable by nothing.

| Workflow | State |
|---|---|
| Report partial output, accept, rework, scrap, hold, release | **Engine only** — `src/lib/outputs.ts`, 15 tests, no screen calls any of it. A hold set directly in the database correctly blocks the parent; nobody can set one from the app. |
| Sub-assembly handoff — allocate, confirm location, install, return | **Engine only**, except the automatic allocation on completion |
| Inventory — receive, reserve, issue, transfer, return, count, adjust | **Engine done and audited** (12 tests, row locks, DB constraints). Receive and issue are reachable; transfer, count and adjust are not. |
| Drawings and instructions at the station | **Not started.** `attachments` table is written by nothing. |
| Time corrections — request, review, approve, reject | **Half.** A supervisor can correct directly, audited and append-only. There is no request, no approval step, and no bar on self-approval. |
| Order completion — finish, close labour, receive finished goods, dispatch | **Not started** as a flow. |

**Sequence within this section:** output reporting and inspection first (it unblocks §2's
Complete button), then order completion, then drawings, then the remaining inventory
operations, then correction approvals.

## §4 The order page — **partly done**

Answers today: where it is (sub-assembly tree with progress), what is holding it up
(blockers per step), overall percentage.

Missing: required vs accepted quantity; blocker **owner and age** on the order page (the
supervisor home has both — the order page should too); target dates beyond the due date;
drawings and checks; a chronological history, though every event is already stored in
`task_events` and needs only rendering.

**One wording change to make:** the percentage is expected-minutes earned, so it must be
labelled **estimated work completed**, and **assembly readiness shown separately**. A unit
at 95% with one missing component is not 95% ready to ship, and the current label invites
exactly that reading.

## §5 Dependability details — **partly done**

| Have | Do not have |
|---|---|
| Idempotent commands with stable ids — a retry after a timeout cannot double-consume, and there is a test that fails if the locks are removed | Search by order, item, serial or customer |
| Human-readable validation on the paths that have it: "Short 2 units of Damper Blade", "Anna works at Coil Line — they could see this step but not start it" | Saved filters ("my area", "due this week", "blocked") |
| Empty states on every list | Explicit loading / error / permission-denied states |
| Errors surfaced on the card that caused them | Visible save confirmation; connection status and last refresh |
| 44px targets throughout, text alongside every status colour | Unsaved-configuration warnings; QR labels; keyboard operation audit |

The idempotency work is the expensive part of this section and it is already done. Most of
the rest is a week of UI.

**Online-only, and it must stay honest:** no action may ever render as committed until the
server says it is. It does not today, and that is the rule to keep when offline support is
eventually considered.

## §6 Live-factory safeguards — **the section standing between us and a pilot**

| Area | State |
|---|---|
| Released revisions frozen | **Not done.** Editing a routing or BOM still reaches orders already on the floor. This is a data-integrity bug, not a feature gap. |
| Permissions — multi-station, supervisor area scope, protected pay and time data | **Not done.** `users.stationId` is one column. Every server action authorises, but on role and one station only. |
| Authentication — password reset, login throttling, session revocation, demo accounts removed | **Not done.** Six seeded accounts share one password. Fine for a demo, disqualifying for a pilot. |
| Audit history | **Largely done.** Every status change, correction, assignment and stock movement is append-only with an actor. Configuration changes are not yet logged. |
| Attachments — authorised access, size and type limits, safe upload | **Not started** (no upload exists). |
| Deployment — separate demo, test and production | **Not done.** One environment. |
| Monitoring — application errors, failed jobs, database problems, reconciliation failures | **Not done.** The reconciliation check exists and runs in the simulation; nothing runs it on a schedule or alerts on it. |
| Backup and demonstrated restore | **Not done.** |
| Tested migrations and a documented rollback | **Partly** — schema changes are applied by a cross-platform script; there is no rehearsed rollback. |

**Authorisation is enforced per request already**, including on individual records — a
worker cannot start a step at another station even by calling the action directly, and
there is a test for it. What is missing is the *shape* of the model (one station per
person), not the enforcement.

**Two numbers to agree with Thermal before configuring anything:** how much data they can
afford to lose, and how long they can be down. Backups are set from those two answers, and
a backup nobody has restored is not a backup.

## §7 Onboarding and support — **not started**

Import templates and preview for products, BOMs, routings, people and opening stock; a
first-order walkthrough; worker and supervisor guides; a support contact and issue
process; release notes; customer data export; and a defined commercial package.

**Product name:** the app is branded Thermal Corp throughout — colours, copy, seed data.
It needs a reusable product name with Thermal's branding applied as configuration, or the
second customer is a fork.

## §8 Release sequence

1. **One order end to end through the UI** — including inspection, sub-assembly handoff,
   finished-goods receipt and reconciliation. This is §3 and it is the largest piece.
2. **Revisions, permissions, correction approvals** — §6's integrity items.
3. **Worker and supervisor polish on real tablets** — the measurements are clean; the
   devices are not yet in hand.
4. **Prove backup restore, deployment rollback, realistic concurrent load.**
5. **Limited Thermal pilot with agreed success measures.**

Out of the first release, explicitly: camera automation, advanced scheduling, forecasting,
extensive analytics.

---

## The standing blocker, unchanged

**Nobody has confirmed how Thermal Corp actually builds an air handler.** The eight
stations and every routing come from their public catalogue. The software treats routings
as data, so correcting them is configuration rather than code — but no readiness claim can
be made about a factory model nobody has checked. One real order, its BOM, its traveller,
and an hour on the floor closes this.

## Known and accepted

Twenty-one controls measure 36 px rather than 44 — "Correct", "Retire", "Deactivate" on
dense admin tables, and one 24 px checkbox whose label row is 44 px. These are desk
actions on a keyboard and mouse, above the 24 px AA minimum and below the 44 px AAA
enhanced target. Nothing used on the floor is under 44 px. Revisit if admin work turns out
to happen on a tablet.
