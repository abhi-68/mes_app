# Thermal Corp MES — revised production model and build plan

Supersedes the phasing in `architecture.md`. That document's data model description is now
partly out of date; this one is authoritative for scope and sequencing.

## 0. Why this revision exists

The first plan was built around a single linear routing per product, binary done/not-done
steps, and immediate stock deduction. Those assumptions do not survive contact with a
make-to-order fabricator that builds several sub-assemblies in parallel and configures every
unit differently.

Two claims in the earlier plan were wrong and are withdrawn:

1. **"The schema does not need to change."** Stated twice. It is true only for swapping
   station *names*. Dependencies, revision control, material reservations, multi-station
   workers and partial quantities all require new entities. The statement was overconfident.
2. **"Inventory consumption is handled."** It is not safe. See below.

## 1. Defects found in the working prototype

These were verified by direct test against the running system, not inferred.

### 1.1 Material consumption is not idempotent — confirmed

Calling the consume path three times for one operation (as a network retry, a duplicate POST,
or an API client would) produced **six** stock movement rows. The operation consumes two BOM
lines (`SUB-FAN-01 ×1` and `BUY-FILT-2FLAT ×8`), so each of the three calls wrote two rows.
Correct behaviour is two rows in total:

```
Task: "Install fan section & filter rack" on WO-1001
Stock transactions written: 6 (3 calls for one operation)
  BUY-FILT-2FLAT: 64 -> 40   (delta -24, should be -8)
  SUB-FAN-01:      0 -> -3   (delta -3)
```

The UI masks this, because the button is disabled while a request is in flight. That is a
client-side guard only. The server has no idempotency key and no "already consumed for this
operation" check.

### 1.2 Stock can go negative — confirmed

The same test drove `SUB-FAN-01` to **-3**. There is no sufficiency check before consuming,
so the system will happily record building a unit out of parts that do not exist. Any material
shortage view built on top of this would be reporting fiction.

### 1.3 Strict sequence gating is the wrong model — accepted

I added predecessor gating (a step cannot start until every lower-numbered step in its order is
done). This is wrong at **every** level, not only across sub-assemblies.

Across the unit it is obviously wrong: frame fabrication and coil brazing have no reason to be
sequential, and a sequence integer cannot express "final assembly can begin once the coil
section and the panel set are both complete."

It is also wrong *within* a sub-assembly — an earlier revision of this document claimed
sequencing was correct there, which is withdrawn. Operations inside one sub-assembly can run in
parallel too (a drain pan can be prepared while headers are brazed). Explicit dependencies
apply at every level; the sequence number survives only as display order.

### 1.4 Other accepted gaps

- Completion is binary. "3 of 8 panels done" is not representable.
- `users.stationId` is a single column; a worker who covers two stations cannot be modelled.
- BOM and routing are not frozen at release. Editing a template today changes what a released
  order's materials resolve to.
- Multi-write operations are not transactional. A status change, its event, and its stock
  movement can partially apply.
- "Average time" is reported as one undifferentiated number, with no sample count or median,
  and per-worker averages are shown without regard to differing assignments — which makes them
  misleading rather than merely imprecise.

## 2. Revised production hierarchy

```
Customer order            Order #4231 — two configured AHUs, delivery commitments
  └─ Production unit      AHU #4231-01 — configuration, serial, overall readiness
       └─ Sub-assembly    Fan & motor section — materials, operations, owner, progress
            └─ Sub-assembly (nested)   Motor mounting assembly
                 └─ Operation          Assemble motor mount — station, workers, time, quantity
                      └─ Checklist step   Verify fasteners — completion, instructions, evidence
```

Rule for the split: something becomes an **operation** when it needs independent scheduling,
timing, ownership or material consumption. Smaller actions inside it are **checklist steps**.

Both individually serialised units and quantity-based batches must be representable. Quantity
completed, scrapped and awaiting rework are recorded alongside status, not folded into it.

## 3. Operation state model

Replaces the current four-state enum.

| State | Meaning |
|---|---|
| Waiting | Prerequisites or materials not ready |
| Ready | Eligible to start |
| In progress | Work has started |
| Paused | Temporarily stopped, with reason |
| Blocked | A recorded problem prevents progress |
| Completed / Cancelled | Terminal |

Readiness is derived from dependency records plus material availability — never from a
sequence number alone.

## 4. Inventory: reservation, issue, receipt

The current "subtract on start" model conflates two different things and double-counts.

| Event | Behaviour |
|---|---|
| Order released | Reserve required materials; available-to-promise drops |
| Operation starts / material picked | Issue to WIP; relieve the matching reservation |
| Extra material needed | Record an additional issue |
| Unused material returned | Return to stock location |
| Sub-assembly completed | Receive its output as stock or allocated WIP |
| Parent consumes sub-assembly | Issue the sub-assembly to the parent |
| Finished unit accepted | Receive finished goods |
| Shipment | Relieve shipped finished goods |

Worked example: 100 motors, 10 reserved for an order. Available = 90, on-hand = 100. When the
10 are issued: on-hand = 90, reservation = 0, available stays 90. The requirement is counted
once, not twice.

Also required: locations/bins, units of measure and conversions, purchase receipts, transfers,
cycle counts, scrap, returns, and lot/serial tracking where it matters. Every material
requirement references the operation that consumes it.

## 5. Configuration and revisions

Admin-configurable, through the application, with no code change: product families and
options, multi-level BOMs, make-vs-buy per component, operations with prerequisites and
eligible stations, standard setup and run times, instructions/drawings/required checks,
materials issued per operation, and required approvals.

For Thermal specifically, configuration fields are likely to include dimensions, panel
construction, coil type, fan arrangement, filtration and controls — **subject to engineering
confirmation, not assumed**.

On release, the approved BOM, routing and drawing revisions are **frozen** onto the order.
Editing a template must never silently change work already on the floor. Changing released
work creates a documented revision with an approver and an impact assessment.

## 6. Labour and time

Workers drive the timer; the server records the timestamps. Actions are
Start → Pause (with reason) → Resume → Finish.

Workers may view their records and *request* corrections but cannot alter recorded timestamps
or approved timesheets. A supervisor correction preserves the original value, the corrected
value, the reason, the requester, the approver and the approval time. This is enforced in
backend permissions, not by hiding buttons — the current implementation does check roles
server-side, which survives; what is missing is the request/approve flow.

Attendance time is kept separate from job labour time: an eight-hour shift is not eight hours
charged to production. Multiple workers on one operation, shift handover, forgotten timers and
overlapping jobs all need explicit handling. Two workers for one hour is two labour-hours
against one elapsed hour.

## 7. What "average time" means

| Measure | Definition |
|---|---|
| Active labour time | Worker time charged to the operation |
| Operation elapsed time | Start to finish, wall clock |
| Waiting / blocked time | Delay from prerequisites or recorded problems |
| Setup time | Preparation before production |
| Rework time | Correcting completed work |
| Production lead time | Release to finished output |

Report by product configuration, operation, routing revision and comparable quantity, always
with sample count and median. Do not rank workers on a single blended average.

## 8. Roles and scoped permissions

Three roles remain, with scope rather than a flat switch.

| Capability | Worker | Supervisor | Admin |
|---|---|---|---|
| Look up production status | All orders | All orders | All orders |
| Execute tasks | Assigned stations | Within area | Authorised override |
| Record notes and blockers | Yes | Yes | Yes |
| Reassign work | No | Own area | Plant-wide |
| Edit BOM / routing templates | No | Optional | Yes |
| Correct time records | Request only | Approve in scope | Audited correction |
| Receive / adjust inventory | If granted | Scoped | Yes |
| View wages, costs, margins | No | Explicit grant | Explicit grant |

`User.stationId` is replaced by a many-to-many station assignment. Operational progress is
visible to everyone; timesheets, wages, customer contacts and margins are not.

## 9. Schema additions (conceptual, not final SQL)

| Area | Entities to add or revise |
|---|---|
| Org / access | Department, WorkCenter, StationAssignment, Permission |
| Product definition | ItemRevision, ProductConfiguration, BOMRevision, RoutingRevision |
| Production | ProductionAssembly, Operation, OperationDependency, ChecklistResult, ProductionReport |
| Materials | MaterialRequirement, Reservation, InventoryLocation, InventoryMovement |
| Traceability | Lot, SerialNumber, ComponentAllocation |
| Labour | LaborSession, AttendanceEntry, TimeCorrection, TimesheetApproval |
| Purchasing | Supplier, PurchaseOrder, Receipt |
| Quality | InspectionResult, Hold, ReworkRecord |
| History / integration | DomainEvent, ExternalObservation, AuditRecord, OutboxMessage |

Current state lives in normal tables; business events are appended alongside. A status change,
its event, and its inventory and time effects must commit in one transaction. Duplicate clicks
and API retries must not consume twice (defect 1.1); concurrent starts must not allocate the
same remaining stock twice.

For future cameras and sensors, keep the shared pipeline but distinguish an **observation**
from an **authorised completion command**. Store device identity, event id, observation time,
receipt time, confidence and evidence, and apply configured validation or approval before any
production state changes.

## 10. Feature register

Priority: P1 = pilot-blocking, P2 = operational completeness, P3 = later.
B/I: Build vs Integrate.

| Feature | Thermal use case | Pri | Acceptance criteria | B/I |
|---|---|---|---|---|
| Dependency-driven readiness | Coil and frame run in parallel; final assembly waits on both | P1 | An operation shows Ready only when all prerequisite operations and materials are satisfied | B |
| Assembly readiness view | "What is holding up final assembly on 4231-01" | P1 | Names the specific missing component or operation, not just a percentage | B |
| Reserve / issue / receipt inventory | Stop double-counting motors | P1 | Motor example in §4 reproduces exactly; stock cannot go negative | B |
| Idempotent state transitions | Retries and double clicks | P1 | Replaying a start 3× produces one issue and one event | B |
| Partial quantity reporting | "3 of 8 panels done" | P1 | Completed / scrapped / rework quantities recorded without closing the operation | B |
| Protected labour records | Worker cannot edit own time | P1 | Unauthorised edit fails at the API, not just in the UI; correction keeps original + approver | B |
| Frozen revisions at release | Template edit must not alter live orders | P1 | Editing a routing leaves a released order's operations unchanged | B |
| Multi-station assignment | A worker covers two cells | P1 | One worker appears in two station queues | B |
| Material shortage view | Missing qty, affected orders, ETA, owner | P2 | Lists shortages with responsible person and supplier ETA | B |
| Digital job traveler | Current drawing + checks at the station | P2 | Station screen shows the frozen drawing revision for that order | B |
| QR / barcode scanning | Open an order or material by scan | P2 | Scanning a label opens the right record | B |
| Quality hold and rework | Failed work must not look shippable | P2 | A held unit cannot reach Ready-to-ship | B |
| Purchasing and receiving | Incoming material visibility | P2 | Receipt increases stock and clears the shortage | B |
| Alerts | Blocked work, late parts, unclosed timers | P2 | Notification fires on each condition | B |
| Shipping records | Link completed units to dispatch | P2 | Dispatch relieves finished goods | B |
| Planned vs actual cost | Labour and material variance | P3 | Visible only with explicit permission | B |
| Import / export / backup | Data safety | P2 | Restore verified, not just taken | B |
| Accounting / payroll | GL and wages | P3 | — | **I** |
| Advanced capacity scheduling | Finite-capacity planning | P3 | — | Later |
| Supplier performance, maintenance, subcontracting, customer portal, vision | — | P3 | — | Later |

## 11. Build phases

| Phase | Deliverable |
|---|---|
| 0 — Validate factory process | Map one real Thermal order: sub-assemblies, stations, materials, handoffs, existing records |
| 1 — Foundation | Access control, versioned product definitions, assembly hierarchy, dependencies, inventory and event foundations |
| 2 — Working production pilot | Release one order; reserve and issue materials; run parallel sub-assemblies; protected labour; readiness view |
| 3 — Operational completeness | Purchasing, receiving, shortages, returns, scrap, inspection and rework, shipping, timesheet approval |
| 4 — Management tools | Workload planning, alerts, comparable averages, costs, configurable reports |
| 5 — Expansion | Advanced scheduling, integrations, maintenance, offline sync, vision and sensors |

Demonstration and check-in after each phase.

### Pilot acceptance tests

The Phase 2 pilot is not accepted until all five hold:

1. An unauthorised worker cannot edit a time record — enforced at the API.
2. Duplicate completion does not double-consume inventory.
3. Partial output is tracked correctly.
4. A missing required part prevents readiness.
5. Editing a template leaves released orders intact.

Tests 1, 2 and 5 are currently failing or unimplemented; test 2 has a confirmed reproduction
in §1.1.

## 12. What carries forward from the prototype

Not everything is rework. These survive largely intact:

- Auth, session handling and server-side role enforcement.
- The append-only event log concept (`task_events`) — it generalises to `DomainEvent`.
- Append-only time entries with separate adjustment rows — the storage shape is right; the
  request/approve workflow is what is missing.
- Admin-editable reason codes.
- The UI layer: design tokens, shop-floor contrast and touch targets, the worker station
  screen with its live timer, and the unit → sub-assembly → step presentation. The data behind
  these changes; the interaction patterns are validated and worth keeping.

## 13. Open dependency — this is the critical path

Phase 0 cannot be completed from public sources. Thermal Corp's website and their 2013 Air
Handlers catalog give the product structure but not the factory workflow, and this has now been
flagged three times. The station list and assembly sequence currently in the seed data remain a
best guess.

What is needed from Thermal Corp, for one real order, end to end:

- The actual station and work-centre list, with who works where.
- One order's real sub-assembly breakdown and the true handoff points.
- Which operations genuinely run in parallel, and what each one waits on.
- How material is currently issued to the floor, and from where.
- What is recorded today (travelers, spreadsheets, sign-off sheets) and by whom.
- Which configuration options actually vary between units.

Until that exists, further building risks encoding assumptions that will have to be unwound.
