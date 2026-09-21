# Cutover evidence — application now uses the inventory engine

Commit `6196158` (cutover in `4fec21b`). Verified from a cold start on 2026-09-15:
database dropped and rebuilt, schema pushed, constraints applied, seed re-run, full suite
and browser demo executed fresh. Nothing here is quoted from an earlier run.

This document exists because the source archive has not been reaching the reviewer for three
turns, while project docs have. The key source is therefore reproduced inline.

**Correction to my previous message:** I reported "47 tests". That was wrong — it is **38**
(2 concurrency + 12 inventory + 15 outputs + 9 task-action). The commit message's phrasing
"38 engine/action tests plus 9 task-action" also reads as 47; the 9 are part of the 38.

---

## 1. The old write path is removed, not merely unused

Three independent checks, run against the current tree and live database:

```
=== Legacy tables in the schema? ===
  references in schema.ts: 0
  tables in the live database: count: 0

=== Legacy consumption function — any definition or caller? ===
  src/lib/work-orders.ts:325: * `consumeComponentsForTask` and `receiveFinishedGoods` wrote straight to
  (the sole remaining occurrence is the comment below — the functions no longer exist)

=== Anything writing inventory outside the engine? ===
  (no results — only src/lib/inventory.ts writes inventory)
```

`inventory_items` and `stock_transactions` were **dropped from the schema**, so admin opening
stock, the seed and the inventory page all had to move onto the engine. What remains in
`src/lib/work-orders.ts` is the tombstone:

```ts
/*
 * REMOVED — the legacy consumption path.
 *
 * `consumeComponentsForTask` and `receiveFinishedGoods` wrote straight to
 * inventory_items with no idempotency key, no transaction around the surrounding
 * status change, and no sufficiency check. A replayed start consumed materials
 * again and stock could go negative (SUB-FAN-01 reached -3).
 *
 * Inventory is now changed only through src/lib/inventory.ts, which enforces
 * command identity, row locking, the non-negative constraint and reservation
 * ownership. There is deliberately no second way in.
 */
```

## 2. The updated task action

`src/app/actions/tasks.ts`. Authorization runs at the boundary before anything is touched;
materials are issued through the engine; status, labour and the audit event join the **same**
transaction.

```ts
async function authorizeTask(taskId: number) {
  const user = await requireUser();
  const task = await db.query.workOrderTasks.findFirst({
    where: eq(workOrderTasks.id, taskId),
    with: { workOrder: true },
  });
  if (!task) throw new CommandError("Task not found", "NOT_FOUND");

  if (!isManager(user.role) && task.stationId && task.stationId !== user.stationId) {
    throw new CommandError("This step belongs to another station", "STATE_GUARD");
  }
  return { user, task };
}

export async function startTask(taskId: number, commandId: string): Promise<ActionResult> {
  return wrap(async () => {
    const { user, task } = await authorizeTask(taskId);          // <- boundary check
    if (task.status === "DONE") throw new CommandError("Already complete", "STATE_GUARD");

    await db.transaction(async (tx) => {                          // <- ONE transaction
      const exec: Exec = { tx };                                  // <- engine joins it
      const locationId = await defaultLocationId(exec);
      const now = new Date();

      // Materials first: if they cannot be issued, nothing else happens.
      const reqs = await tx
        .select()
        .from(materialRequirements)
        .where(eq(materialRequirements.operationId, taskId));

      for (const req of reqs) {
        const cover = await coverageFor(req.id, exec);
        const outstanding = Math.max(0, req.requiredQty - cover.netIssued);
        if (outstanding === 0) continue;                          // <- already satisfied

        if (cover.activeReserved < outstanding) {
          await reserveForRequirement({
            commandId: `${commandId}:reserve:${req.id}`,          // <- derived, stable
            requirementId: req.id, itemId: req.itemId, locationId,
            quantity: outstanding - cover.activeReserved,
          }, exec);
        }

        const after = await coverageFor(req.id, exec);
        if (after.uncovered > 0) {
          throw new CommandError(
            `Short ${after.uncovered} of the material this step needs`,
            "INSUFFICIENT_STOCK"
          );                                                       // <- rolls everything back
        }

        await issueAgainstReservation({
          commandId: `${commandId}:issue:${req.id}`,
          requirementId: req.id, itemId: req.itemId, locationId,
          quantity: outstanding, actorUserId: user.id,
        }, exec);
      }

      await tx.update(workOrderTasks).set({ status: "IN_PROGRESS", ... });
      // ... labour session opened, work order advanced, taskEvents row appended ...
    });
  });
}
```

The engine gained an `Exec` parameter so a command can join a caller's transaction rather than
opening its own:

```ts
export type Exec = { db?: Db; tx?: Tx };

function run<T>(exec: Exec, body: (tx: Tx) => Promise<T>): Promise<T> {
  if (exec.tx) return body(exec.tx);            // join the caller's transaction
  return (exec.db ?? defaultDb).transaction(body);
}
```

## 3. Stable command ids across retries

`src/components/TaskCard.tsx`. The id is minted once per action and **kept** on failure, so a
retry carries the same one; it is cleared only after success.

```ts
const commandIds = useRef<Record<string, string>>({});
const commandIdFor = (action: string) => {
  if (!commandIds.current[action]) {
    commandIds.current[action] = crypto.randomUUID();
  }
  return commandIds.current[action];
};

const run = (fn, opts = {}) => {
  startTransition(async () => {
    const res = await fn();
    if (!res.ok) {
      setError(res.error);            // keep the id — the retry must reuse it
    } else {
      if (opts.clears) delete commandIds.current[opts.clears];
    }
  });
};

// Start button
onClick={() => run(() => startTask(task.id, commandIdFor("start")), { clears: "start" })}
```

## 4. Integration results — the task action, not the engine

`tests/task-action.test.mts` calls `startTask` directly, with the session stubbed per case.

```
ok 1 - successful start: one motor issued, task started, clock running, event written
ok 2 - duplicate request with the SAME command id consumes material once
ok 3 - a NEW command id does not let the same start consume twice
ok 4 - insufficient stock: task does not start and nothing is consumed
ok 5 - held stock: task does not start even though stock physically exists
ok 6 - rollback: a failure mid-action leaves no partial state
ok 7 - authorization: a worker cannot start a step at another station
ok 8 - authorization: a supervisor may start a step at any station
ok 9 - authorization: an unauthenticated caller is refused
```

Mapping to the requested cases: successful issue (1), retry (2, 3), shortage (4), held stock
(5), unauthorized access (7, 9), transactional rollback (6).

The rollback case gives the action two requirements and stocks only the first, so the failure
occurs *after* a material issue has already been written inside the transaction. It then
asserts the motor issue was rolled back, the reservation was rolled back, the task stayed
`PENDING`, and no movement or event row survived.

## 5. Full suite, cold run

```
ok 1 - A1 — competing reservations genuinely overlap; the second blocks on the lock
ok 2 - many simultaneous reservations for one unit yield exactly one winner
ok 1 - sequential competition for the last motor leaves exactly one commitment
ok 2 - A2i — replaying an identical material issue applies once
ok 3 - A3i — a legitimate second partial material issue is additive
ok 4 - A4 — reusing a command id with a different payload is rejected (material issue)
ok 5 - A5 — a failed command leaves nothing partially applied
ok 6 - A6 — stock cannot go negative
ok 7 - A6b — an unreserved issue cannot take another order's reserved stock
ok 8 - A6c — coverage is zero after the reservation is fully issued
ok 9 - A6d — the reservation's owner can issue it; another order cannot
ok 10 - returns raise the uncovered quantity again
ok 11 - ledger and balances reconcile after a full cycle
ok 12 - partial reservation records a shortage rather than failing
ok 1 - A2 — replaying an identical production report applies once
ok 2 - A3 — a legitimate second partial production report is additive
ok 3 - A4 — reusing a command id with a different quantity is rejected (production report)
ok 4 - A7b — new output is pendingInspection, neither usable nor scrap
ok 5 - issue to parent then return restores usable output
ok 6 - returned output can be reissued
ok 7 - accept, rework, then re-accept does not invent a second unit
ok 8 - A8c — rejecting an installed component keeps its installation history
ok 9 - A13b — dependency stays satisfied after the allocation is consumed
ok 10 - A7 — allocation, not global accepted, decides who is ready
ok 11 - A6e — held stock can be neither reserved nor issued
ok 12 - A6f — releasing a hold restores availability exactly once
ok 13 - a reservation owner still cannot draw stock that is on hold
ok 14 - A6g — a hold releases the reservations it invalidates
ok 15 - reconciliation checks stock, reservations and holds against their own histories
ok 1 - successful start: one motor issued, task started, clock running, event written
ok 2 - duplicate request with the SAME command id consumes material once
ok 3 - a NEW command id does not let the same start consume twice
ok 4 - insufficient stock: task does not start and nothing is consumed
ok 5 - held stock: task does not start even though stock physically exists
ok 6 - rollback: a failure mid-action leaves no partial state
ok 7 - authorization: a worker cannot start a step at another station
ok 8 - authorization: a supervisor may start a step at any station
ok 9 - authorization: an unauthenticated caller is refused

total 38  pass 38  fail 0
```

PostgreSQL 16.13, Node v22.22.2. `scripts/run-tests.mjs` runs one file per process,
sequentially, because each truncates the database.

## 6. Browser demonstration

`scripts/demo-cutover.mjs` drives the real UI with Playwright and queries the database
directly between steps.

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

Inventory changed exactly once on the successful start — one unit, one movement row. The
failed action left the step `PENDING` with nothing drawn, and showed a message naming the
shortfall rather than a generic error.

## 7. Mutation checks

Each defect reintroduced into the engine, suite re-run:

```
ALL row locks removed                     -> fails concurrency A1 + contention test
                                             (the OLD A1 passed this, which is why it
                                              was replaced)
unreserved issue ignores heldQty          -> fails A6e
hold leaves stale reservations standing   -> fails A6g
reserved issue uses the unreserved guard  -> fails 7 tests incl. A6d
availableNow ignores heldQty              -> fails A6e, A6f
returns do not relieve installed quantity -> fails issue-return, reissue
dependency ignores installed quantity     -> fails A13b
coverage = required - reserved            -> fails A6c, returns
replay protection disabled                -> fails A2i
```

## 8. Also fixed during the cutover

- A **hydration mismatch**: the running clock rendered server elapsed time, then a different
  client value. Surfaced by a dev-overlay badge in the demo screenshot. Now renders a stable
  placeholder until mounted. Dev log shows zero hydration errors.
- A **foreign-key ordering bug** in the shared test reset: `bom_lines` references
  `routing_steps`, so it must be deleted first.

## 9. Still not implemented

Unchanged from the last report, and none of it is claimed:

- Operation dependencies. Simple sequence gating is still what the UI uses — visible in the
  demo, where the motor step was gated behind the prior step rather than a dependency record.
  `A13b` proves the dependency *calculation* only.
- Revision freezing at release.
- Scoped permissions with many-to-many station assignment; `users.stationId` is still a single
  column.
- Time-correction request/approve flow.
- Thermal Corp's real factory process remains unvalidated.

## 10. Where the code is

| Path | Contents |
|---|---|
| `src/app/actions/tasks.ts` | The cut-over task action |
| `src/lib/inventory.ts` | Balances, reservations, issues, returns, holds, reconciliation |
| `src/lib/outputs.ts` | Production reporting, inspection, allocation, install/return/reject |
| `src/db/schema.ts` | Schema; legacy inventory tables removed |
| `src/db/constraints.sql` | CHECK constraints for the §1 invariants |
| `tests/task-action.test.mts` | The nine integration cases above |
| `tests/concurrency.test.ts` | Genuine overlapping-transaction locking test |
| `scripts/demo-cutover.mjs` | The browser demonstration |
