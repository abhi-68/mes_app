# Comparing ours against a real MES

## Where to look

Ranked by how fast you can actually be clicking something.

### 1. Odoo — best single comparison, ~5 minutes to get in

https://www.odoo.com/trial — free trial, **no credit card, instant access**, and the first app
stays free forever with unlimited users. Pick **Manufacturing**, then also install **Shop
Floor**, **Inventory**, **Quality** and **Maintenance** from the Apps screen (all free on the
trial).

This is the closest comparison to what we built, and the one to spend real time in. Odoo's Shop
Floor app is a tablet-optimised worker view — the same job as our `/my-station`. Their
Manufacturing app covers work orders, work centres, routings and BOMs; Quality covers control
points and checks; Inventory covers reservations and moves.

Load the demo data when it offers — clicking an empty system tells you nothing.

### 2. ERPNext — open source, so you can read how they did it

https://frappe.io/erpnext/manufacturing/job-cards — several partners run public demos (search
"ERPNext demo"; they rotate). ERPNext's **Job Card** is their per-operation worker record, the
direct equivalent of our `work_order_tasks`. Because it is open source, when something puzzles
you in the UI you can go read the model behind it — that is worth more than another polished
demo.

### 3. Katana and MRPeasy — the small-manufacturer end

https://katanamrp.com and https://www.mrpeasy.com/pricing/ both run self-serve free trials.
Katana is one of your named references. Both are lighter than Odoo; useful for seeing what a
*simple* version of this looks like, which is a real design question — more features is not
automatically better for a shop floor.

### 4. Epicor — watch it, you cannot run it

There is **no public trial and no sandbox**. Epicor's own user forum is blunt about it: without
an existing licence or partner status you are, in one member's words, out of luck. Demos go to
prospective buyers through a salesperson. So the only honest way to see Kinetic is to watch it.

What is watchable without talking to anyone:

- **[Epicor's on-demand product tours](https://www.epicor.com/en-us/products/enterprise-resource-planning-erp/kinetic/product-tours/)**
  — twelve videos, three of them specifically Advanced MES: *Improve Efficiency on the Shop
  Floor*, *Improving Quality and Reducing Scrap*, and *Data Analytics for Advanced MES*.
- **[The MES terminal, screen by screen](https://erp-demos.net/epicor-training/kinetic-mes/)**
  — a consultancy's training video covering starting production, reporting quantity, ending
  production, recording scrap and non-conformance, the work queue, the material queue and the
  supervisor's shop tracker. Free preview; the full library wants a registration.
- Consultant walkthroughs on YouTube, e.g. *Mastering MES Start & End in Epicor Kinetic*.

**How it actually works, and the part worth taking.** Kinetic splits this in two. *Standard MES*
is an operator-entered terminal — clock on to a job operation, report quantity, end the
activity, log scrap or a non-conformance — which is the same shape as our worker screen.
*Advanced MES* is the paid tier that stops trusting people for the numbers: machine interface
units listen to the equipment, every cycle is counted automatically, and sensor data is watched for
drift before defects appear.

Two details from the standard tier are worth stealing and cost us little:

- **A material queue beside the work queue.** The station sees not only its jobs but what
  material is staged or on its way. We show the job and say nothing about where the parts are.
- **A downtime reason that cannot be skipped.** When a machine stops, the operator is made to
  pick a reason there and then, or the supervisor gets an alarm. That is how downtime logs stay
  honest — ours has the reason codes and nothing that insists on them.

Also worth noticing: **non-conformance is separate from scrap** in their model. A part that
fails is not automatically waste; it enters a disposition process. Our engine has that
distinction and no screen for it.

What not to copy: the machine-connected half needs hardware Thermal Corp may not have, and
Epicor is a different weight class — these are multi-year implementations with a consultancy
attached. Watch it for the shape of the worker terminal, not the feature count.

---

## What to look for, and what we have

Work through this while you click. It is ordered roughly by how much it would matter to Thermal
Corp.

### Things we have — check whether theirs is better

| Function | Where to see it in Odoo | Ours |
|---|---|---|
| Worker's own queue of jobs | Shop Floor app | `/my-station` |
| Start / pause / finish with a real clock | Shop Floor, the timer on each work order | Start, Mark done, running clock |
| Routings — different steps per product | Manufacturing → Configuration → Operations; the Operations tab on a BoM | `/admin/products/[id]` |
| Bill of materials, multi-level | Manufacturing → Products → Bills of Materials | same, with sub-assembly work orders spawned automatically |
| Material consumed when production runs | Inventory moves on a manufacturing order | our inventory engine, on Start |
| Reserved vs available stock | Inventory → Forecasted / Reserved | `available_now`, reservations, holds |
| Scrap and rework reasons | Manufacturing → Scrap; Quality alerts | `/admin/reason-codes` |
| Time per step, actual vs expected | Manufacturing → Reporting → Work Orders Performance | `/reports` |

### Things they have and we do not — the real list

Watch for these specifically. This is where the gap is.

1. **Dependencies between operations.** In Odoo, open a manufacturing order with several work
   orders and look at how one becomes "Ready" — it can wait on a specific component arriving,
   not just on the previous step's number. Ours still gates purely by step sequence. **This is
   the single biggest gap, and it is the exact thing Thermal Corp asked for** — "we wait for
   parts and nobody tells us."

2. **Quality inspection as a screen.** Odoo's Quality app puts control points on operations and
   makes the worker pass or fail them. We have the whole engine for this — produce, inspect,
   accept, rework, scrap, reject-after-install, 15 tests on it — **with no screen calling it.**
   It is library code nobody can reach from the UI yet.

3. **Work instructions and drawings at the station.** Odoo attaches a worksheet (PDF or built-in
   steps) to each operation and shows it on the tablet. Our schema has an `attachments` table
   that **nothing reads or writes.**

4. **Barcode / scanner input.** Odoo has a whole barcode app and it works offline. We have
   nothing — every action is a mouse click. On a real floor with gloves and grease this matters
   more than it sounds.

5. **Lot and serial traceability.** Odoo tracks which lot went into which finished unit and can
   show the genealogy both ways. We track quantities, not identities — we cannot answer "which
   units got the bad batch of bearings."

6. **Scheduling and capacity.** Odoo has a planning/Gantt view over work centres with capacity
   and load. We have no scheduling at all — order of work is whatever the sequence says.

7. **Purchasing and the supply side.** Odoo will tell you a component is short and let you raise
   a purchase order. We report the shortage and stop there.

8. **Mobile / tablet layout.** Odoo's Shop Floor is built thumb-first for a tablet on a cart.
   Ours is a responsive desktop layout. Look at how big their buttons are.

9. **Downtime and OEE.** Machine stoppage reasons, availability, performance. We have reason
   codes but no downtime model.

10. **Approvals.** Odoo has approval flows on corrections and adjustments. Our time corrections
    are recorded and audited but nobody has to approve them.

### Things we have that the small tools often do not

Not to flatter the build — these are worth checking so you know what you would lose by just
buying Katana instead:

- **Convergent sub-assembly progress.** Each sub-assembly gets its own work order and its own
  progress, rolling up into the parent weighted by expected minutes. Check whether Katana can
  even model a two-level build.
- **Timesheets workers cannot edit.** Ask yourself, in each tool, whether a worker could quietly
  change how long they took.
- **Retry safety.** In any tool you try: start a job, then hit the browser back button and start
  it again. See whether it consumes the material twice. Ours does not, and that took real work.

---

## The question actually worth answering

After a couple of hours in Odoo you will have a list of twenty features we lack. Most of them
are not the point. Thermal Corp's stated problem is one sentence — people wait on parts and
nobody tells them — and a general-purpose MES answers it generically because it has to serve
every factory.

So while you are clicking, the useful question is not "what is missing" but **"how many screens
does it take Odoo to answer *is my unit ready to assemble, and if not what am I waiting on*?"**
If the answer is four screens and a mental model, that is the space this project is in.

Bring back the three or four things that genuinely made you think "we need that," and we will
build those rather than chasing feature parity with a product that has had twenty years and a
few hundred engineers.

---

Sources: [Odoo Manufacturing](https://www.odoo.com/app/manufacturing) ·
[Odoo trial](https://www.odoo.com/trial) ·
[ERPNext job cards](https://frappe.io/erpnext/manufacturing/job-cards) ·
[Katana](https://katanamrp.com/features/manufacturing/) ·
[MRPeasy pricing](https://www.mrpeasy.com/pricing/) ·
[Epicor Kinetic product tours](https://www.epicor.com/en-us/products/enterprise-resource-planning-erp/kinetic/product-tours/)
