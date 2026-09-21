# Thermal Corp MES — prototype

Manufacturing execution system for a make-to-order fabricator. **Demonstration data only —
no live factory record exists in any environment.**

## Status

Not complete — a working prototype with a tested core and four specified-but-unbuilt features.
**`docs/STATUS.md` is the honest inventory**; the summary:

| Area | State |
|---|---|
| Inventory engine (reserve / issue / return / hold, command idempotency, transactions) | Implemented, tested |
| Output dispositions (produce / inspect / allocate / install / return / reject) | Implemented, tested |
| Hierarchical work orders and sub-assembly progress | Implemented |
| Operation dependencies and the "What's waiting" view | Implemented, tested |
| Worker, supervisor and admin screens | Implemented; task actions cut over to the engine |
| Quality inspection | Engine implemented and tested; **no screen calls it** |
| Revision freezing, scoped permissions, time corrections | **Specified, not built** |
| Event-ingestion API (scanners, PLCs, vision) | **Not started** |
| Thermal Corp's real factory workflow | **Not known** — station list and routing are a best guess |

Read `docs/IMPL-SPEC.md` for the accounting rules and their correction history.
`docs/PLAN-V2.md` sets scope and phases. `docs/ARCHITECTURE.md` is superseded and marked so.

## Running it

Requires Node 22+ and PostgreSQL 16. Works on Windows, macOS and Linux.
**`docs/RUNNING.md` is the full guide** — installing Postgres, what to click, and how to verify
the tests have teeth.

```bash
npm install
npm run db:setup   # writes .env if missing, rebuilds mes_dev, seeds
npm run dev        # http://localhost:3000
```

`db:setup` exists because two steps are easy to miss: the CHECK constraints are not in the
Drizzle schema and must be applied from `src/db/constraints.sql`, and the seed inserts rather
than upserts, so re-running it against a seeded database fails.

Demo logins, password `password123` for all:
`admin@`, `supervisor@`, `worker1@`…`worker4@thermal-corp.com`. Sign in as `worker3@`
(Fan & Motor Assembly) to see a step that consumes material when it starts.

## Tests

```bash
npm run test:setup   # drops and recreates mes_test
npm test             # total 54  pass 54  fail 0
```

Each test file truncates the database, so `scripts/run-tests.mjs` runs one file per process,
sequentially. The suite refuses to run unless `DATABASE_URL` names `mes_test`.

A browser demonstration of the same behaviour: `node scripts/demo-cutover.mjs ./out` with the
dev server running (it mutates `mes_dev`; re-run `npm run db:setup` afterwards).

## Showing it to someone

`docs/DEPLOY.md` puts it on a link (Vercel + Neon, free, about 30 minutes).
`docs/DEMO-SCRIPT.md` is the walkthrough and the questions that turn it into discovery.

## Where the logic lives

| Path | Contents |
|---|---|
| `src/lib/inventory.ts` | Balances, reservations, issues, returns, holds, reconciliation |
| `src/lib/outputs.ts` | Production reporting, inspection, allocation, install/return/reject |
| `src/lib/work-orders.ts` | Order release, sub-assembly spawning, progress roll-up |
| `src/db/schema.ts` | Drizzle schema |
| `src/db/constraints.sql` | CHECK constraints (invariants 1, 3, 4, 5) |
| `tests/` | Acceptance scenarios A1–A13b |

## Inventory has exactly one write path

`src/lib/inventory.ts` is the only way stock changes. The legacy `inventory_items` and
`stock_transactions` tables are **deleted from the schema**, not merely unused, so there is no
second route in. Opening stock from the admin screen and from the seed both enter as `RECEIPT`
movements through the engine.

`startTask` commits the status change, the material issue, the labour session and the audit
event in one transaction; a shortage rolls back all of it. Command ids are minted once per
user action in the UI and reused on retry, so a repeated tap is recognised as the same action.

## Not implemented

Operation dependencies (simple sequence gating is still in use), revision freezing at release,
scoped permissions with many-to-many station assignment, and the time-correction
request/approve flow. These are specified in `docs/IMPL-SPEC.md` and are the next steps.
