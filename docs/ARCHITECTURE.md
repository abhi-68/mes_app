# Thermal Corp MES — Architecture & Build Plan

> **SUPERSEDED for scope and sequencing — see `plan-v2.md`.**
>
> **Retraction:** this document twice says the schema does not need to change when the real
> factory process is known. That is wrong, and only true for swapping station *names*.
> Operation dependencies, revision freezing, material reservations, multi-station workers and
> partial quantities all require new entities. `plan-v2.md` has the corrected model, a feature
> register, and two confirmed defects in the prototype's inventory handling.

> **Update:** the user provided Thermal Corp's own 2013 "Air Handlers" engineering catalog
> (72 pages — CF/F/TS/T series, sizing tables, fan/coil selection, guide specifications).
> It is a product/sales catalog, not a floor plan — it has no station layout, headcount, or
> process sequence. It did let us replace the earlier guessed BOM vocabulary with Thermal
> Corp's actual construction terms (see §3/§4 below). The assembly *sequence* and *station
> list* are still a best-guess based on standard air-handler assembly practice, not confirmed
> floor data — swap the seed file's content once the real process is known; the schema does
> not need to change.

## 1. Context

Thermal Corp (thermal-corp.com) manufactures custom air handling equipment — air handling
units, blower coils, column units, filter housings, fan coils/heat pumps — built largely to
order rather than off a standard line. Sub-components (insulated panels, doors, coils, motor
assemblies, filter sections) are fabricated on different stations/lines and then brought
together for final assembly.

**The problem this software solves:** those stations don't currently talk to each other.
Final assembly sometimes sits waiting on a part with nobody able to say where it is or when
it'll be ready, because progress is tracked on paper or not at all. There's no single place
where anyone can log in and check "where is order #4231 right now" or where a worker can
simply tick off "I finished this step."

**Reference points:** Fishbowl, Katana, and Epicor were named as inspiration for the general
shape of an MES/inventory system. The project also has wiseDo's proposal/brochure on file —
its "one shared data model, every module reads and writes to it" pattern and its
Sense → Reason → Act framing are directly useful here, even though wiseDo's product itself
leans on cameras/edge AI we are not building yet. The relevant idea to borrow: **build one
event-based data model now, so a future vision or sensor system can plug in as just another
event source later, without a redesign.**

## 2. Scope decisions (confirmed with user)

- **Industry fit:** custom/made-to-order assembly manufacturing (Thermal Corp / HVAC
  equipment) — products built from multiple fabricated sub-parts, assembled at the end.
- **MVP scope:** "Full MES-lite" — planning (work orders + routing), production tracking
  (tasks/tick-off), and basic inventory. Not doing finite-capacity scheduling, quality/NCR
  workflows, or subcontract tracking in v1 — those are natural v2 additions once the core
  loop is in daily use.
- **Roles (v1):** Worker, Supervisor, Admin.
  - **Worker:** sees tasks assigned to their station, ticks them complete, adds notes.
  - **Supervisor:** everything a worker can do, plus oversees a department/line, reassigns
    tasks, sees bottlenecks for their area.
  - **Admin:** full access — creates customers, items, BOMs, routings, work orders, users;
    sees everything across the plant.
  - Any logged-in user (any role) can look up any work order/item and see its live status —
    that's the core "stop waiting, just check" feature the user asked for.
- **Tech stack:** Next.js 14 (App Router, TypeScript), PostgreSQL via Prisma ORM,
  Auth.js (NextAuth) for login/sessions, Tailwind + shadcn/ui for the UI. Chosen because it's
  one deployable codebase, works well for multi-role dashboards, and is easy to self-host
  (Docker/VPS/on-prem, matching the on-premise pattern in the wiseDo reference docs) or run on
  managed hosting (Vercel + a managed Postgres) — either is possible without changing code.
  It also gives a clean path to add a mobile-friendly PWA later for shop-floor tablets.
- **Extensibility requirement:** the user wants to be able to bolt on vision-based systems
  (cameras, sensors) later. v1 includes a small event-ingestion API (API-key authenticated
  REST endpoint) that posts into the same `TaskEvent` log a human tick-off uses — so a future
  camera system marking a step "done" and a worker tapping a checkbox are the same kind of
  event under the hood. No schema change needed to add that later.

## 3. Data model (v1)

```
User            id, name, email, passwordHash, role (WORKER|SUPERVISOR|ADMIN), stationId?
Station         id, name (e.g. "Panel Fab", "Coil Line", "Final Assembly")
Customer        id, name, contact info
Item            id, sku, name, description, isFinishedGood (bool)
BOMLine         id, parentItemId, componentItemId, quantity   -- what an Item is built from
RoutingStep     id, itemId, sequence, name, stationId, expectedMinutes
                -- template: "to build Item X, do these steps in order, at these stations"
WorkOrder       id, orderNumber, itemId, customerId, quantity, dueDate, status, createdBy
WorkOrderTask   id, workOrderId, routingStepId, status (PENDING|IN_PROGRESS|DONE|BLOCKED),
                assignedStationId, completedByUserId, completedAt, notes
TaskEvent       id, workOrderTaskId, type (STARTED|COMPLETED|BLOCKED|NOTE|EXTERNAL_EVENT),
                actorUserId?, source (HUMAN|API), payload(json), createdAt
                -- append-only log; this is the "event spine" — every status change, human or
                   future-machine, is one row here. Current status is derived/cached on the task.
InventoryItem   id, itemId, quantityOnHand, reorderPoint
StockTransaction id, inventoryItemId, workOrderTaskId?, delta, reason, createdAt
ApiKey          id, label, hashedKey, scope   -- for future external systems posting events
```

This gives us: BOM (what's made of what), Routing (what steps/stations an item passes
through), Work Orders (an actual customer order to build N of an Item), Tasks (one row per
step per work order — this is what a worker ticks off and what the live progress view reads),
and a lightweight inventory ledger.

### Seed data v2 — catalog-informed, still not a confirmed floor plan

Per Thermal Corp's own Air Handlers catalog, a unit (e.g. a CF Series air handling unit) is
actually built from: a welded/formed casing frame, insulated casing panels, access doors, a
coil section (chilled water / DX / hot water / steam / electric), a fan & motor section
(forward-curved / airfoil / plenum fan, belt or direct drive), a filter section (flat /
cartridge / bag / HEPA), and an electrical & controls package (disconnects, starters, VFDs).
The seed data's BOM now uses these real component names.

The **station list and assembly order are still a best guess** (Frame Fab → Panel & Door Fab
→ Coil Line → Fan & Motor Assembly → Electrical & Controls → Final Assembly → QC/Dispatch),
built from standard AHU assembly practice since Thermal Corp's actual floor layout, station
names, and process sequence were not available. Replace `src/db/seed.ts` with real data once
that's known — no schema change required.

## 4. Build phases

1. **Spec & data model** (this document) — done.
2. **Scaffold**: Next.js + Postgres + Prisma + Auth.js, seeded with demo Thermal Corp data
   (a couple of items, BOMs, routings, stations, one admin/supervisor/worker login each).
3. **Core engine**: Prisma schema live, server actions/API routes for Work Orders, Tasks,
   Routing, BOM CRUD.
4. **Worker view**: task list for "my station," tap to mark complete, add a note.
5. **Live progress view**: search/browse any work order or item, see every routing step and
   its status, who completed it and when — available to every logged-in role.
6. **Supervisor/Admin dashboards**: create work orders and master data, see all open work
   across stations, reassign/unblock tasks.
7. **Inventory basics**: stock on hand per item, auto-decrement on task completion for BOM
   components, low-stock flag.
8. **Extensibility hook**: API-key-authenticated endpoint that posts a `TaskEvent` from an
   external source (future camera/sensor system) into the same pipeline.
9. **End-to-end test pass + delivery**: walk all three roles through a realistic order,
   fix issues, write run/deploy instructions, hand over the codebase.

Each phase after this one will be built, shown to the user (running app / screenshots), and
checked in on before moving to the next — per the "step by step" approach requested.
