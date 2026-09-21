# Continuation — material availability and reservations

2026-09-17. Based on the latest supplied source archive, `01-mes-app_2.zip`.

## Delivered

The Materials navigation link opens `/materials`. All signed-in roles can search open material requirements by order, part, SKU, operation or station, and filter for stock shortages, reservable stock or sub-assemblies. Cards show required, net issued, reserved, sub-assembly supplied and uncovered quantities. Stock cards show on-hand, held and free quantities.

Supervisors and admins can reserve the available quantity against one operation's requirement. Workers have read-only access; the server action independently checks the caller's role. Partial availability results in a partial reservation and an explicit uncovered quantity. Reservations do not reduce on-hand stock or start work. The existing Start action issues the reserved stock.

The new command locks the operation before recomputing demand, shares that lock with Start, and records its original response for safe retries. Reusing a command ID with different inputs is refused. A NOTE event records who reserved material. Sub-assembly requirements use the output handoff path and cannot be satisfied with this stock-reservation action.

No database schema migration is needed for these changes.

## Limits

- This is a stock-reservation screen, not a manual finished-subassembly allocation screen.
- The default picking location is the lowest location ID, used consistently by planning and Start. Multi-location picking is not implemented. Reservations created elsewhere by direct engine calls are outside this UI workflow.
- Reservations do not select or prove the physical lot picked. The existing issue behavior is unchanged.
- Availability is a refreshable preview. Several requirements can display the same shared free stock; quantities are checked again inside the reservation transaction.
- There is no reservation release/reallocation UI in this change.
- Retry IDs survive a failed request while this screen stays mounted, not a browser restart. The remaining-demand check also limits a fresh command to current uncovered demand.
- The current floor model, released revision behavior, permission scope and other previously documented release gaps remain unvalidated or unfinished.

## Verification in this environment

| Check | Result |
| --- | --- |
| Next route type generation and TypeScript check | Passed |
| Production build | Passed, including `/materials` |
| ESLint for new workflow and test files | Passed |
| Barcode encoder and time-proration tests | 18 passed |
| New material-planning database tests | 8 added; attempted, all blocked in setup by PostgreSQL `ECONNREFUSED` |
| Full database regression suite | Not run |
| Authenticated UI walkthrough and browser layout check | Not run; require a working database |

These results do not reproduce the earlier uploaded test totals and do not establish production readiness. PostgreSQL was unavailable here, so reservation concurrency and database behavior still need execution against the real database engine.

## Continue on a machine with PostgreSQL

Use a separate development/test checkout. Configure `.env` from `.env.example` with local database credentials and an authentication secret. Install dependencies with `npm ci`, then follow `docs/RUNNING-AND-TESTING.md` if present or the project's existing run instructions.

Prepare the disposable test database with `npm run test:setup`, then run `npm test`. The test runner targets `mes_test` and deletes its records: it must never contain business data. The new file `tests/material-planning.test.mts` is discovered automatically.

Run `npm run dev`, open `/materials`, and verify:

1. A worker can view requirements but cannot reserve through a crafted request.
2. A supervisor reserves part of a shortage; on-hand stock stays unchanged.
3. Another order cannot reserve that committed stock.
4. Start consumes the reservation once; retrying does not consume again.
5. Held stock and sub-assembly requirements cannot be reserved through this screen.
6. Refresh reflects receipts, reservations and work started from another browser.

Then run the existing simulation and screen walkthrough. Review this change before piloting it on the factory floor.

## Changed source

- Added `src/lib/material-planning.ts`.
- Added `src/app/actions/materials.ts`.
- Added `src/app/materials/page.tsx`.
- Added `src/components/MaterialPlanning.tsx`.
- Added `tests/material-planning.test.mts`.
- Updated `src/app/actions/tasks.ts` to share the operation lock and picking location.
- Updated `src/components/TopNav.tsx` and `src/app/inventory/page.tsx` to link to Materials.
