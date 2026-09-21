# Thermal Corp MES — Implementation Specification

Revision 5. Companion to `plan-v2.md`; that document sets direction, this one defines the
rules an implementer must follow. **[CONFIRM]** marks a rule needing Thermal Corp
confirmation, with a proposed default so work is not blocked.

Status: demonstration data only. No live factory record exists in any environment.

### Corrections in revision 2

Revision 1 contained three formulas that produce wrong numbers. All three were reproduced
before being rewritten:

| Was | Counterexample | Now |
|---|---|---|
| `scrapped = produced − accepted − awaitingRework` | 4 panels made, none yet inspected → reported **4 scrapped** | §1: scrap is an explicit disposition, never a residual |
| `uncovered = required − reserved` | 10 motors reserved then issued → reported **10 missing** | §4: coverage counts issued material |
| `ATP = availableNow + receipts − reservations` | 100 on hand, 10 reserved → returned **80**, should be 90 | §4: ATP starts from on-hand, counts each commitment once |

Also corrected: production dispositions and allocation were described as one set of "buckets"
when they are two independent axes (§1); the ledger was described as append-only while §6
required updating a balance row (§5); a new command id was implied to permit a repeated action
(§6); only `Pause` defined labour-session closure (§8); and acceptance scenario A7 omitted the
allocation step that stops two assemblies claiming the same output (§9).

### Corrections in revision 3

| Was | Counterexample | Now |
|---|---|---|
| Issue guard `onHand − activeReserved >= qty` | 10 on hand all reserved to A; A issues 10 → `10−10 >= 10` false, owner locked out | §6: two issue policies — reserved issues verify ownership, unreserved issues keep the guard |
| `REQUIRED_QUANTITY` read only `allocatedOutstanding` | allocate 4, consume them, block, unblock → dependency unsatisfied, can never resume | §2: counts `allocatedOutstanding + consumedAgainst` the same requirement |
| `allocatedOutstanding + consumed <= accepted` | 4 consumed, 2 later rejected → `0+4 <= 2` false, late defect unrecordable | §1 invariant 3, with rejection of installed output not rewriting the child |

### Corrections in revision 4

| Was | Counterexample | Now |
|---|---|---|
| `usableOutput` subtracted a **monotonic** `consumed` | accept 1, issue to parent, return it unused → still reported 0 usable | §1 Axis B: current-state quantities, `issuedToParentOutstanding` net of returns |
| `cumulativeAccepted` monotonic | one unit accepted → reworked → re-accepted counted as 2 units | §1 Axis B: disposition is current state; `produced` never changes on rework |
| `availableNow = onHand − activeReserved` | 5 motors all on hold, none reserved → reported 5 available | §1 invariant 6: `− heldQty`, enforced in both reserve and issue |

The root cause of all three: current availability was being derived from monotonically
increasing counters. The balances-versus-history separation already applied to stock in §5 now
applies to output dispositions too.

### Corrections in revision 5

Rev 4 changed the availability rule but did not carry it through the whole document. Consistency
fixes, no new architecture:

| Location | Was | Now |
|---|---|---|
| §6 unreserved issue | `onHand − activeReserved >= qty` | `− heldQty` as well |
| §5 `InventoryBalance` | listed `onHand`, `activeReserved` only | `heldQty` included, as the formulas and reconciliation already required |
| §2 `REQUIRED_QUANTITY` | used `consumedAgainst`, undefined once rev 4 removed the consumption counter | `netInstalledAgainst`, defined as current net fulfilment less returns and post-install scrap |
| §4 | "the same rule binds both reservation and issue" | every command excludes held stock, but a reserved issue keeps its own ownership guard — applying the unreserved guard to it would reintroduce the rev-3 bug |
| §9 | §12 gated on A6e and A6f, which did not exist | A6e, A6f, A6g, A14 and A15 written out |
| §4 | a hold left standing reservations against held stock | placing a hold releases the reservations it invalidates, atomically |

---

## 1. Quantity accounting

Two independent axes. Confusing them was the root of the revision-1 error.

### Axis A — production disposition

Every unit produced sits in exactly one disposition. They sum to `produced`:

```
produced = pendingInspection + accepted + awaitingRework + scrapped
```

Scrap is recorded by an explicit `DispositionRecord`, never derived as a residual. Newly made
output is `pendingInspection` until someone judges it.

Permitted disposition transitions, each an appended record:

```
pendingInspection -> accepted | awaitingRework | scrapped
awaitingRework    -> accepted | scrapped          (after rework)
accepted          -> awaitingRework | scrapped    (only via an audited reversal, e.g. late hold)
```

### Axis B — lifecycle of accepted output

**Current availability is never derived from a monotonically increasing counter.** This is the
same separation already applied to stock in §5 — a transactionally maintained current state,
with append-only history beside it — and it must be applied here too.

| Kind | Fields | Purpose |
|---|---|---|
| **Current state** (mutable) | `pendingInspection`, `accepted`, `awaitingRework`, `scrapped`, `allocatedOutstanding`, `issuedToParentOutstanding`, `heldQty` | What is true now. Drives availability and readiness. |
| **History** (append-only) | `DispositionRecord`, `AllocationRecord`, `InventoryMovement` | What happened. Drives audit and traceability. Never rewritten. |

```
usableOutput = accepted − allocatedOutstanding − issuedToParentOutstanding − heldQty
```

Every term is a **current** quantity. `issuedToParentOutstanding` is net of returns.

Two cases this must handle, both of which a monotonic model gets wrong:

**Issue then return.** Accept 1, issue it to a parent, then return it unused and re-approve it.
Current state moves `accepted:1, issuedToParentOutstanding:1` → `accepted:1,
issuedToParentOutstanding:0`, so `usableOutput` returns to 1. The original issue movement
remains in history. A monotonic `consumed` would have reported 0 for ever.

**Rework then re-accept.** A rejected component is repaired and accepted again. Disposition
moves `accepted → awaitingRework → accepted` on the **same** physical unit; `produced` never
changes. A monotonic `cumulativeAccepted` would have counted 2 and invented a unit that does
not exist.

**Consumption history is still never unwound by a later quality decision.** Rejecting output
that is already installed in a parent does not rewrite the producing operation's disposition —
it appends a `QualityRejection` and places the **parent** on hold (§5). Returning a component
is a different event from rejecting one: a return is a physical movement that restores
availability, a rejection is a quality judgement that does not.

### Invariants

Must hold after every committed transaction. Violation is a bug, not a warning.

1. `pendingInspection + accepted + awaitingRework + scrapped = produced`
2. All four disposition quantities `>= 0`
3. `allocatedOutstanding + issuedToParentOutstanding <= accepted`, all **current** quantities.
   Rejecting output already installed in a parent leaves both `accepted` and
   `issuedToParentOutstanding` untouched (§5), so a late defect stays recordable.
4. `onHand >= 0` at every location — **no path may drive stock negative**
5. `activeReserved >= 0`, `heldQty >= 0`, and `activeReserved + heldQty <= onHand`
6. `availableNow = onHand − activeReserved − heldQty`, and `availableNow >= 0`.
   **Held stock is not available.** Omitting `heldQty` reports 5 motors available when all 5
   are on quality hold, and an unreserved issue would then take them.

Invariant 4 is the one the prototype violates today (`SUB-FAN-01` reached `−3`).

---

## 2. Dependency rules

A sequence number is display order only. Readiness comes from explicit dependency records,
which apply at every level — between sub-assemblies and between operations inside one
sub-assembly.

| Type | Satisfied when |
|---|---|
| `FULL_COMPLETION` | Predecessor operation is `COMPLETED` |
| `REQUIRED_QUANTITY` | `allocatedOutstanding(req) + netInstalledAgainst(req) >= n` |
| `SPECIFIC_UNIT` | The named serial or lot is allocated to, or already consumed against, this demand |
| `QUALITY_ACCEPTANCE` | No open hold on the allocated or consumed source output |

Two things this must get right.

**It tests allocation, not global accepted quantity.** Testing `accepted >= n` would let two
assemblies each claim the same four panels.

**It must count material already installed against this requirement.** Installing relieves
outstanding allocation (§1), so a rule reading only `allocatedOutstanding >= n` fails the
moment the work actually proceeds: allocate 4 panels, install them, block, unblock — the
recheck sees outstanding 0 and the operation can never resume.

`netInstalledAgainst(req)` is **current net fulfilment**, not a historical total. Rev 4
removed the monotonic consumption counter, so this term must be derived the same way:

```
netInstalledAgainst(req) = installed(req) − returnedFromParent(req) − scrappedAfterInstall(req)
```

A component returned to stores no longer fulfils the requirement; one scrapped after
installation no longer fulfils it either, and both raise the requirement again. A component
merely *rejected* while still installed does continue to fulfil it physically — the parent is
held instead (§5), which is a different mechanism.

Both terms are scoped to the specific material requirement, never to the order.

### Allocation and reservation are one commitment

`ComponentAllocation` (which output unit is earmarked for which demand) and inventory
`Reservation` (which stock is earmarked) are two representations of the same commitment. They
are created, relieved and cancelled in the same transaction; neither may move without the
other.

Both are scoped to a **material requirement**, not to an order. Two operations within one order
must not both claim the same motors, which an order-level scope would permit.

```
OperationDependency
  id
  operationId              -- the dependent operation
  dependsOnOperationId     -- nullable when the dependency is on material only
  type
  requiredQuantity
  requiredSerialOrLotId
```

### Readiness

An operation is `READY` only when all hold:

1. Every `OperationDependency` is satisfied by its type's rule.
2. Every `MaterialRequirement` for the quantity being started has `uncovered = 0` (§4), against
   reservations **owned by this material requirement**, at a location the station can draw from, with no
   quality hold.
3. The operation is not itself held or cancelled.

Condition 2 is what stops two orders both appearing ready against the same last motor.

---

## 3. Operation state machine

| From | To | Trigger | Guard |
|---|---|---|---|
| `WAITING` | `READY` | dependencies and material satisfied | §2 |
| `READY` | `WAITING` | reservation lost or hold raised | — |
| `READY` | `IN_PROGRESS` | `StartOperation` | authorised station; state guard applies regardless of command id |
| `IN_PROGRESS` | `PAUSED` | `PauseOperation(reason)` | — |
| `PAUSED` | `IN_PROGRESS` | `ResumeOperation` | **remaining** requirements and current holds only (§4) |
| `IN_PROGRESS` | `BLOCKED` | `BlockOperation(reason, note)` | reason from fixed list |
| `BLOCKED` | `READY` / `IN_PROGRESS` | `UnblockOperation` | re-check §2 on remaining requirements |
| `IN_PROGRESS` | `IN_PROGRESS` | `ReportProduction(...)` | partial reports allowed repeatedly |
| `IN_PROGRESS` | `COMPLETED` | `CompleteOperation` | planned quantity met, or explicit short-close with reason |
| non-terminal | `CANCELLED` | `CancelOperation` | releases reservations, records disposition of issued material (§5) |
| `COMPLETED` | `IN_PROGRESS` | `ReverseCompletion` | audited; downstream impact check (§5) |

**Any transition out of `IN_PROGRESS` — pause, block, complete or cancel — closes every open
labour session on that operation**, recording the transition as the close reason. This is a
single rule, not four.

`ResumeOperation` must **not** re-check the original reservation requirement. Materials already
issued satisfy demand; re-checking would make resuming impossible and could issue the same
material twice.

---

## 4. Material: demand, reservation, issue

| Concept | Definition |
|---|---|
| Requirement (demand) | What the order needs per operation, from the frozen BOM revision |
| Reservation | Usable stock earmarked to this order; reduces availability to others |
| Issue | Stock physically moved to WIP; relieves the matching reservation |
| Uncovered | Remaining unmet demand (below) |
| Expected supply | Linked purchase or production order; **never counted as on-hand** |

### Coverage

```
netIssued = issued − returned − scrappedFromWip
uncovered = max(0, required − netIssued − activeReserved)
```

- **returned** — material came back to stores, so the demand is unmet again.
- **scrappedFromWip** — issued material destroyed at the operation; demand unmet again and a
  further issue is needed.
- **replacement** — a replacement issue simply increments `issued`; the original component's
  allocation history is preserved, never overwritten.

Worked check: required 10, reserved 10, all 10 issued → `netIssued = 10`, `activeReserved = 0`,
`uncovered = max(0, 10 − 10 − 0) = 0`. Correct. Revision 1 reported 10.

### Shortage is normal

Requiring 10 motors when 6 exist is representable, not an error:

```
required          10
activeReserved     6
uncovered          4
expectedSupply     PO-882, 4 units, ETA 2026-10-02   (not available stock)
```

Release proceeds; affected operations sit `WAITING` naming the shortage.

### Current availability vs available-to-promise

```
availableNow(item, location) = onHand − activeReserved − heldQty
```

This is what readiness uses, and it is the pilot's only availability calculation.

**Every command excludes held stock** — reservation, unreserved issue and reserved issue
alike, including direct API calls. But they do not all use the *same guard*, and conflating
them reintroduces the rev-3 bug:

| Command | Guard |
|---|---|
| Reserve | `onHand − activeReserved − heldQty >= qty` |
| Unreserved issue | `onHand − activeReserved − heldQty >= qty` |
| **Reserved issue** | `reservation.outstanding >= qty` **and** `onHand − heldQty >= qty` |

A reserved issue must **not** be made to pass the unreserved availability check. Its quantity
is already counted in `activeReserved`, so subtracting reservations again would reject the
reservation's rightful owner — exactly the defect corrected in rev 3. It excludes held stock
and nothing else.

Available-to-promise is a **planning** figure, deferred until after the pilot, and defined once
correctly here so it is not re-derived wrongly later:

```
remainingDemand(requirement) = max(0, required − netIssued)

ATP(D) = onHand
       + expectedReceipts(receiptDate <= D)
       − Σ remainingDemand(requirements with dueDate <= D)
```

It starts from **on-hand**, not from `availableNow`. Starting from `availableNow` subtracts
reservations once inside that term and again in the demand sum — the revision-1 error, which
returned 80 where 90 was correct.

### Placing a hold releases the reservations it invalidates

A hold makes stock unusable. Any reservation or allocation standing against the held quantity
can no longer be honoured, so **placing a hold releases them in the same transaction**.

Without this, an earlier reservation would still nominally authorise a reserved issue of the
held component, and correctness would depend entirely on the secondary `onHand − heldQty`
guard catching it. Defence in depth is good, but the commitment should not survive the thing
it was committed against.

Rules:

1. A hold may be placed on any quantity up to `onHand − heldQty` — reserved stock included.
2. If `activeReserved + heldQty` would then exceed `onHand`, reservations are released until
   it does not, **newest first**, preserving the seniority the reservation system already
   grants (§9 A1: first to reserve wins).
3. Each release decrements `activeReserved`, reduces that reservation's outstanding quantity,
   and appends a `DEALLOCATE` record naming the requirement.
4. The affected requirements' `uncovered` rises again automatically, since coverage reads
   live reservations.
5. Releasing the hold does **not** re-create the reservations. The material is available
   again and must be re-reserved, which is the honest outcome — priorities may have changed
   while it was held.

### Movement types

`RECEIPT`, `ISSUE`, `RETURN`, `TRANSFER`, `ADJUSTMENT`, `SCRAP`, `PRODUCTION_RECEIPT`,
`SHIPMENT`, `REVERSAL`.

---

## 5. Ledger and balances

Revision 1 said balances were derived and nothing edited in place, then required locking and
updating a balance row. Both are needed; they are different objects.

| Object | Nature |
|---|---|
| `InventoryMovement` | Append-only accounting history. Never updated or deleted. |
| `InventoryBalance` | Transactionally maintained summary per item and location: `onHand`, `activeReserved`, `heldQty`. Locked for updates and read for availability checks. All three are required by the §1 invariants, the §4 formulas and the reconciliation below. |
| Reconciliation | Periodic job asserting **`onHand` equals the sum of movement history** and **`activeReserved` equals the sum of outstanding reservations**. Reservations are commitments, not stock movements, so they reconcile against their own records — never against the movement ledger. `heldQty` reconciles against open holds. A mismatch is an incident. |

The non-negative CHECK constraint lives on **`InventoryBalance`**. Issue checks must also be
reservation-aware: order A may not consume stock reserved to order B, even when raw `onHand`
looks sufficient.

### Reversals, cancellation, rework

| Situation | Behaviour |
|---|---|
| Order cancelled before production | Release reservations; no movements |
| Order cancelled after issue | Record disposition of issued material and WIP — return, scrap or hold. Never silently discarded |
| Incorrect completion reported | Audited reversal; re-evaluate operations that its output made ready |
| Component fails inspection, not yet consumed | Hold the quantity, deallocate it, dependents return to `WAITING` |
| Component fails inspection, already consumed | Append a `QualityRejection`; place the **parent** on hold. The child's `consumed` and disposition are **not** rewritten — it was installed, and that remains true. Parent cannot complete or ship until an explicit disposition (remove / replace / rework / scrap parent) is recorded. Allocation and installation history preserved |
| Replacement needed | Issue replacement; original component's history retained |
| Released design changes | Approved change record naming affected operations and materials |

Cancellation and reopening append compensating records. They never erase labour, movements or
production history.

---

## 6. Command identity and concurrency

### Idempotency is per command, and does not bypass state guards

Every state-changing command carries a client-generated `commandId` (UUID).

```
ProcessedCommand
  commandId    PRIMARY KEY     -- database-enforced uniqueness
  commandType
  payloadHash                  -- detects id reuse with different arguments
  resultRef
  processedAt
```

1. Replaying a `commandId` returns the original result and applies nothing further.
2. A **new** `commandId` authorises a **new valid action** — it does not permit a repeated one.
   A second `StartOperation` with a fresh id on an already-started operation still fails the
   state guard in §3. Idempotency and state guards are independent checks; both apply.
3. Legitimate repetition is expressed by commands that are additive by design —
   `ReportProduction` and `IssueMaterial` may be sent many times with distinct ids.
4. A reused `commandId` with a different `payloadHash` is rejected as a client error.

### Concurrency

- All effects of one command — status, movements, balances, labour, domain event — commit in a
  **single database transaction**. Partial application is not permitted.
- Stock decrements take a row lock on the balance row (`SELECT … FOR UPDATE`). There are
  **two issue policies**, and using the unreserved guard for a reserved issue is a bug — it
  rejects the reservation's rightful owner (10 on hand, 10 reserved to A, A issues 10:
  `10 − 10 >= 10` is false).

  **Issue against a reservation** — lock the balance row *and* the reservation row, then:
  1. verify the reservation belongs to this material requirement;
  2. verify `qty <= reservation.outstanding` and `qty <= onHand`;
  3. decrement `onHand`, `activeReserved` and `reservation.outstanding` together;
  4. append the movement and update requirement coverage.

  The guard is `reservation.outstanding >= qty AND onHand − heldQty >= qty`. It never
  consults `availableNow`, because the quantity is already this order's — but it does
  exclude held stock, which nobody may draw. This matches the table in §4.

  **Unreserved (ad-hoc) issue** — guard is `onHand − activeReserved − heldQty >= qty`, which
  protects both other orders' reservations and anything on quality hold.
- The CHECK constraint on `InventoryBalance` is a backstop, so a path that forgets the guard
  fails loudly rather than corrupting the ledger.
- Reservations for the same item and location serialise on the same balance row.

---

## 7. Permissions

Enforced in the command handler. UI hiding is presentation only, never the control.

| Capability | Worker | Supervisor | Admin |
|---|---|---|---|
| View production status | All orders | All orders | All orders |
| Execute operations | Assigned stations only | Within own area | Authorised override, audited |
| Record notes / blockers | Yes | Yes | Yes |
| Reassign work | No | Own area | Plant-wide |
| Edit BOM / routing templates | No | Optional grant | Yes |
| Modify a recorded timestamp | **Never** | **Never** | **Never** — corrections only |
| Submit a correction request | Yes | Yes | Yes |
| Approve a correction | No | Within scope | Yes |
| Approve own request | **No** | **No** | **No** |
| Receive / adjust inventory | Only if granted | Scoped | Yes |
| View wages, costs, margins | No | Explicit grant | Explicit grant |

No timestamp is ever edited in place by anyone, including an admin. Corrections append.

`User.stationId` is replaced by
`StationAssignment(userId, stationId, role, validFrom, validTo)`. A worker may hold several; a
supervisor may oversee several departments.

---

## 8. Labour and time

| Question | Decision | Rationale |
|---|---|---|
| Does pausing stop every worker's timer? | Yes — and so does blocking, completing and cancelling. Any exit from `IN_PROGRESS` closes all open sessions with the transition as the reason. An individual `ClockOff` closes only that worker's session and does **not** change operation state. | Two different events; conflating them corrupts both elapsed and labour time |
| One worker on several jobs at once? | No by default: one open session per worker. Optionally enabled per site for machine tending, in which case elapsed time is split evenly across concurrent sessions. | Stops one attended hour becoming three labour-hours |
| Open sessions at shift change | Auto-closed at shift end, flagged `autoClosed`, surfaced to the supervisor to confirm. Never silently discarded, never left open. | Forgotten timers are the commonest data-quality failure |
| Who approves a supervisor's own correction? | Another supervisor, or an admin. Self-approval rejected server-side. | Segregation of duties |
| What locks? | On timesheet period approval, its sessions lock. | Approved payroll input must be stable |
| Changes after approval | Reopen the period, or append a post-approval adjustment linked to the original with approver and reason. | History stays reconstructable |

Attendance time and job labour time are separate entities. An eight-hour shift is not eight
hours charged to production. Two workers for one hour is two labour-hours against one elapsed
hour.

---

## 9. Acceptance scenarios

### Inventory and concurrency

**A1 — competing orders for the last motor.** Given 1 motor on hand, unreserved; when orders A
and B attempt to reserve 1 in **genuinely overlapping transactions on separate database
connections**; then exactly one reservation succeeds, the other reports `uncovered = 1`,
`onHand` stays 1, `availableNow` becomes 0, and total outstanding reservations equal
`activeReserved`.

The overlap must be real. A test that issues two calls and lets them serialise proves nothing:
an implementation with **no row locking at all** passes it. The test must hold the first
transaction open, observe the second block on the lock, then commit the first and see the
second resolve against the updated state.

**A2 — replaying an identical partial production report.** Given produced 0; when
`ReportProduction(commandId=X, produced=3)` is sent twice; then produced is 3, with one
disposition record and one domain event.

**A2i — replaying an identical partial material issue.** The same property for
`IssueAgainstReservation`. Distinct from A2: material issue and production reporting are
separate commands and replay protection must be proven for each.

**A3 — a legitimate second partial report.** Given A2; when
`ReportProduction(commandId=Y, produced=2)` is sent; then produced is 5.

**A3i — a legitimate second partial material issue.** The same property for
`IssueAgainstReservation`.

**A4 — command id reused with different payload.** Given A2; when
`ReportProduction(commandId=X, produced=99)` is sent; then rejected as a client error, produced
remains 3.

**A4b — new command id does not bypass a state guard.** Given an operation already
`IN_PROGRESS`; when `StartOperation` is sent with a fresh `commandId`; then it fails the state
guard and nothing changes.

**A5 — failure midway leaves nothing partial.** Given completion writes status, movements and
labour; when the movement write fails; then all of it rolls back.

**A6 — stock cannot go negative.** Given 1 on hand; when an issue of 3 is attempted; then it is
rejected by the guard, `onHand` stays 1, and the CHECK constraint is never reached.

**A6b — reservation-aware issue.** Given 5 on hand with 5 reserved to order A; when order B
attempts to issue 1; then rejected, even though raw `onHand` is sufficient.

**A6c — coverage after issue.** Given required 10, reserved 10, then all 10 issued; then
`uncovered = 0` and the operation does not report a shortage.

**A6d — the reservation's owner can issue it; nobody else can.** Given 10 motors on hand, all
10 reserved to order A's requirement; when A issues 10 against that reservation; then it
succeeds, `onHand = 0`, `activeReserved = 0`, `reservation.outstanding = 0`. When order B
attempts to issue the same 10; then it is rejected.

**A6e — held stock can be neither reserved nor issued.** Given 5 on hand, none reserved; when
all 5 are placed on hold; then `availableNow = 0`, a reservation attempt reserves 0, an
unreserved issue is rejected, and `onHand` remains 5 because the stock physically exists.

**A6f — releasing a hold restores availability exactly once.** Given the hold from A6e; when it
is released; then `availableNow = 5`. Replaying the release command applies nothing further,
and a release sent with a **new** command id fails the state guard rather than restoring 5
again — availability never reaches 10.

**A6g — a hold releases the reservations it invalidates.** Given 5 on hand with 3 reserved to
requirement A; when all 5 are placed on hold; then the hold succeeds, A's reservation is
released to 0, `activeReserved = 0`, A's `uncovered` rises by 3, and a reserved issue by A is
rejected. Releasing the hold does not re-create A's reservation.

**A14 — issue, return, reissue.** Given 1 accepted unit allocated and installed into a parent;
when it is returned unused; then `usableOutput` is 1 again, `produced` is still 1, and the
original install remains in history. When it is then allocated and installed against a
different requirement; then that succeeds, `produced` is still 1, and the first requirement's
coverage no longer counts it.

**A15 — accept, rework, re-accept is one physical unit.** Given 1 unit accepted; when it is
moved to `awaitingRework` and later back to `accepted`; then `produced` is 1 throughout,
`accepted` is 1, `usableOutput` is 1, and invariant 1 holds at every step. The unit is never
counted twice.

### Production flow

**A7 — partial output releases downstream by allocation.** Given 8 panels ordered and 4
produced, inspected and accepted; and those 4 **allocated to assembly A's requirement**; when
readiness is evaluated; then assembly A becomes `READY`, assembly B (also requiring 4) remains
`WAITING` with `uncovered = 4`, and the panel operation stays `IN_PROGRESS`.

**A7b — pending inspection is not usable and not scrap.** Given 4 panels produced and not yet
inspected; then `scrapped = 0`, `accepted = 0`, `pendingInspection = 4`, and no dependent
operation becomes ready.

**A8 — hold before consumption.** Given A7 made assembly A ready; when a hold is placed on 2 of
its 4 allocated panels; then those 2 are deallocated and A returns to `WAITING` naming a
shortfall of 2.

**A8b — hold after consumption.** Given assembly A consumed the 4 panels and progressed; when a
hold is raised on 2 of them; then A inherits a derived hold, cannot complete or ship, requires
an explicit disposition, and the original allocation history is retained.

**A9 — template edit does not affect released work.** Given order O released against routing
revision R1; when R1 is edited to R2; then O's operations, materials and drawings still resolve
to R1.

**A13 — resume does not re-issue.** Given an operation whose materials were issued, then
paused; when resumed; then it resumes without a shortage and issues nothing further.

**A13b — dependency survives consumption.** Given assembly A with a `REQUIRED_QUANTITY`
dependency of 4 panels, which have been allocated and then consumed; when A is blocked and
then unblocked; then the dependency is still satisfied and A resumes without a new allocation
or a new issue.

**A8c — late rejection of a consumed component.** Given assembly A consumed 4 accepted panels;
when 2 are subsequently rejected; then the panel operation's `consumed` and disposition are
unchanged, a `QualityRejection` records the affected component and quantity, assembly A is
placed on hold and cannot ship, an audited replacement issue is permitted, and every §1
invariant still holds.

### Labour

**A10 — direct timestamp modification rejected.** Given worker W's recorded session; when W
calls the modification endpoint directly, bypassing the UI; then rejected with a permission
error and nothing changes.

**A10b — correction request accepted.** Given the same session; when W submits a correction
*request*; then it succeeds and creates a pending request awaiting approval.

**A11 — self-approval rejected.** Given supervisor S requests a correction; when S attempts to
approve it; then rejected.

**A12 — missing part prevents readiness.** Given an operation with `uncovered > 0`; then it
stays `WAITING` and names the missing component and quantity.

---

## 10. Milestones and data status

Replaces the ambiguous phase/live-data mapping in revision 1.

| Milestone | Data | Purpose | Prerequisites |
|---|---|---|---|
| **Demonstration** | Synthetic, clearly labelled | Prove the workflow | None — current state |
| **Live pilot** | Limited real factory use | One line or one product family in anger | Backup with **verified restore**, documented recovery procedure, access controls enforced server-side, support process agreed, Phase 0 walkthrough complete |
| **Rollout** | Full production | More products and departments | Live pilot stable, operational completeness items delivered |

Backup and restore are a gate on entering **Live pilot**, not a later phase. Demonstration work
proceeds without them because nothing real is at stake.

The commercial question of when operational use is chargeable is the owner's decision; these
milestones exist to make that decision well-defined, and this document takes no position on it.

---

## 11. Prototype data

The corrupted rows were demonstration seed data. After the defect was confirmed, the
development database was dropped and reseeded, so the duplicate movements and the negative
balance exist nowhere. There is no verified physical count to reconcile against and no real
history to reconstruct — the seed regenerates from `src/db/seed.ts` on demand.

**Resetting the seed did not fix the engine.** The defective code paths are unchanged; only the
data they corrupted is gone. The repair is §§1–6 of this document, not the reseed.

The data-repair procedure below is not owed now. It becomes mandatory at the Live pilot gate:

1. Snapshot before any migration.
2. Identify duplicate movements by command replay, and the orders affected.
3. Reconcile balances against a verified physical count.
4. Correct history through traceable adjustments or reversals — never by editing rows.
5. Mark BOM and routing revisions `UNKNOWN` where they cannot be reliably reconstructed.

---

## 12. Build order

1. **Rebuild the inventory engine** to §§1, 4, 5, 6 — dispositions, allocation, coverage,
   balances with lock and constraint, command identity. Prove with A1–A6f.
2. **Replace sequence gating with dependencies** at every level. Prove with A7, A7b, A8, A8b,
   A8c, A12, A13, A13b.
3. **Freeze revisions at release.** Prove with A9.
4. **Station assignments, scoped permissions, correction request/approve.** Prove with A10,
   A10b, A11.
5. **One complete order** end to end on labelled demonstration data, exercising partial output,
   competing reservations, pause and resume, a quality hold, and an approved time correction.

Steps 1–4 are independent of Thermal's floor layout and proceed now. No claim of
Thermal-validated readiness until the Phase 0 walkthrough in `plan-v2.md` §13 is done.
