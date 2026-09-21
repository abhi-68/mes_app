import "dotenv/config";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { deliverCompletedSubAssembly } from "@/lib/outputs";
import {
  stations,
  users,
  customers,
  items,
  bomLines,
  routingSteps,
  workOrders,
  workOrderTasks,
  inventoryLocations,
  reasonCodes,
  timeEntries,
  taskEvents,
  vendors,
} from "./schema";
import { releaseWorkOrder } from "../lib/work-orders";
import { receiveStock } from "../lib/inventory";
import { raiseAlert } from "../lib/alerts";
import { randomUUID } from "node:crypto";

/**
 * Demo data for Thermal Corp (thermal-corp.com).
 *
 * NOT a confirmed model of Thermal Corp's real shop floor. Product structure comes from
 * their own "Air Handlers" catalog (CF/F/TS/T series). The station list and assembly
 * sequence are a best-guess from standard AHU practice. Replace this file when the real
 * process is known — the schema does not need to change.
 *
 * What this seed demonstrates structurally:
 *   - A top-level unit (CF-3000-H) whose MANUFACTURED sub-assemblies each get their own
 *     child work order with their own routing and their own progress.
 *   - PURCHASED components that are simply consumed from stock, not sub-ordered.
 *   - BOM lines that declare WHICH step consumes them.
 */

async function main() {
  console.log("Seeding Thermal Corp demo data (hierarchical work orders)...");

  // --- Stations ------------------------------------------------------------
  const [sheetMetal, frameFab, panelDoorFab, coilLine, fanMotorAsm, electrical, finalAsm, qcDock] =
    await db
      .insert(stations)
      // Two lines, because a plant that runs one is the easy case and this demo
      // should show the harder one. Fabrication feeds Assembly; `sortOrder` is
      // the order the job travels, which is what the floor map draws.
      .values([
        { name: "Sheet Metal / Cutting", description: "Shear, punch and form sheet stock", line: "Fabrication", sortOrder: 10, number: 10 },
        { name: "Frame Fab", description: "Weld and square the casing frame", line: "Fabrication", sortOrder: 20, number: 20 },
        { name: "Panel & Door Fab", description: "Insulated double-wall panels and access doors", line: "Fabrication", sortOrder: 20, number: 30 },
        { name: "Coil Line", description: "Coil section build, braze and pressure test", line: "Fabrication", sortOrder: 20, number: 40 },
        { name: "Fan & Motor Assembly", description: "Fan wheel, shaft, bearings, motor and drive", line: "Fabrication", sortOrder: 20, number: 50 },
        { name: "Electrical & Controls", description: "Disconnects, starters, VFD wiring", line: "Assembly", sortOrder: 30, number: 60 },
        { name: "Final Assembly", description: "Mount all sections into the casing", line: "Assembly", sortOrder: 40, number: 70 },
        { name: "QC / Dispatch", description: "Leak test, run test, inspection and crating", line: "Assembly", sortOrder: 50, number: 80 },
      ])
      .returning();

  // --- People --------------------------------------------------------------
  const passwordHash = await bcrypt.hash("password123", 10);
  const [admin, supervisor, wFrame, wCoil, wFan, wFinal] = await db
    .insert(users)
    .values([
      { name: "Alex Admin", email: "admin@thermal-corp.com", passwordHash, role: "ADMIN" },
      {
        name: "Femi Okoro",
        email: "forklift@thermal-corp.com",
        passwordHash,
        role: "FORKLIFT",
      },
      {
        name: "Sam Supervisor",
        email: "supervisor@thermal-corp.com",
        passwordHash,
        role: "SUPERVISOR",
        stationId: finalAsm.id,
      },
      {
        name: "Priya Nair",
        email: "worker1@thermal-corp.com",
        passwordHash,
        role: "WORKER",
        stationId: frameFab.id,
      },
      {
        name: "Jordan Mills",
        email: "worker2@thermal-corp.com",
        passwordHash,
        role: "WORKER",
        stationId: coilLine.id,
      },
      {
        name: "Marcus Webb",
        email: "worker3@thermal-corp.com",
        passwordHash,
        role: "WORKER",
        stationId: fanMotorAsm.id,
      },
      {
        name: "Ravi Kumar",
        email: "worker4@thermal-corp.com",
        passwordHash,
        role: "WORKER",
        stationId: finalAsm.id,
      },
    ])
    .returning();

  // --- Reason codes (admin-editable) --------------------------------------
  await db.insert(reasonCodes).values([
    { category: "BLOCKED", code: "WAIT_MATERIAL", label: "Waiting on material" },
    { category: "BLOCKED", code: "WAIT_SUBASM", label: "Waiting on sub-assembly" },
    { category: "BLOCKED", code: "WAIT_DRAWING", label: "Waiting on drawing / approval" },
    { category: "BLOCKED", code: "WAIT_CRANE", label: "Waiting on crane / handling" },
    { category: "SCRAP", code: "DIM_OUT", label: "Dimension out of spec" },
    { category: "SCRAP", code: "MAT_DEFECT", label: "Material defect" },
    { category: "REWORK", code: "WELD_POROSITY", label: "Weld porosity" },
    { category: "REWORK", code: "COIL_LEAK", label: "Coil leak at pressure test" },
    { category: "REWORK", code: "PANEL_FIT", label: "Panel fit / gasket seal" },
    { category: "DOWNTIME", code: "BREAKDOWN", label: "Machine breakdown" },
    { category: "DOWNTIME", code: "CHANGEOVER", label: "Changeover / setup" },
    { category: "DOWNTIME", code: "NO_WORK", label: "No work available" },
  ]);

  // --- Customer ------------------------------------------------------------
  const [customer] = await db
    .insert(customers)
    .values([
      {
        name: "Gulf Coast Mechanical",
        contactName: "D. Alvarez",
        contactEmail: "purchasing@gulfcoastmech.example",
      },
    ])
    .returning();

  // --- Items ---------------------------------------------------------------
  // Purchased (consumed from stock, never sub-ordered)
  const [galvSheet, insulation, copperTube, finStock, motor, fanWheel, filterMedia, elecParts] =
    await db
      .insert(items)
      .values([
        { sku: "RAW-GALV-16", name: "Galvanized Steel Sheet, 16ga", procurementType: "PURCHASED", unitOfMeasure: "sheet", reorderPoint: 40 },
        { sku: "RAW-INSUL-2", name: 'Panel Insulation, 2"', procurementType: "PURCHASED", unitOfMeasure: "sheet", reorderPoint: 40 },
        { sku: "RAW-CU-TUBE", name: 'Copper Tube, 5/8" OD', procurementType: "PURCHASED", unitOfMeasure: "ft", reorderPoint: 500 },
        { sku: "RAW-FIN-AL", name: "Aluminium Fin Stock", procurementType: "PURCHASED", unitOfMeasure: "lb", reorderPoint: 60 },
        { sku: "BUY-MOTOR-5HP", name: "Motor, 5 HP TEFC", procurementType: "PURCHASED" },
        { sku: "BUY-WHEEL-FC", name: "Fan Wheel, Forward-Curved DWDI", procurementType: "PURCHASED" },
        { sku: "BUY-FILT-2FLAT", name: 'Filter Media, 2" Flat MERV 8', procurementType: "PURCHASED" },
        { sku: "BUY-ELEC-KIT", name: "Electrical Kit (disconnect, starter, VFD)", procurementType: "PURCHASED" },
      ])
      .returning();

  // Manufactured sub-assemblies (each gets its OWN routing and its OWN work order)
  const [casingFrame, panelSet, doorSet, coilSection, fanSection] = await db
    .insert(items)
    .values([
      { sku: "SUB-FRAME-01", name: "Welded Casing Frame", procurementType: "MANUFACTURED" },
      { sku: "SUB-PANEL-01", name: "Insulated Panel Set", procurementType: "MANUFACTURED" },
      { sku: "SUB-DOOR-01", name: "Access Door Set", procurementType: "MANUFACTURED" },
      // Pressure-tested before anything is built around it, so finishing the step
      // is not the same as passing the part. This is the one item in the demo that
      // exercises the inspection gate.
      {
        sku: "SUB-COIL-01",
        name: "Coil Section (Chilled Water)",
        procurementType: "MANUFACTURED",
        requiresInspection: true,
      },
      { sku: "SUB-FAN-01", name: "Fan & Motor Section", procurementType: "MANUFACTURED" },
    ])
    .returning();

  // Finished good
  const [ahu] = await db
    .insert(items)
    .values([
      {
        sku: "CF-3000-H",
        name: "CF Series Air Handling Unit - 3000 CFM, Horizontal",
        description: "Custom air handling unit, Classic Welded Frame series, built to order",
        procurementType: "MANUFACTURED",
        isFinishedGood: true,
      },
    ])
    .returning();

  // --- Routings: a DIFFERENT process for each item we make -----------------
  const frameSteps = await db
    .insert(routingSteps)
    .values([
      { itemId: casingFrame.id, sequence: 1, name: "Shear & form frame members", stationId: sheetMetal.id, expectedMinutes: 60 },
      { itemId: casingFrame.id, sequence: 2, name: "Weld frame & square up", stationId: frameFab.id, expectedMinutes: 90 },
      { itemId: casingFrame.id, sequence: 3, name: "Fit base rail & lifting lugs", stationId: frameFab.id, expectedMinutes: 40 },
    ])
    .returning();

  const panelSteps = await db
    .insert(routingSteps)
    .values([
      { itemId: panelSet.id, sequence: 1, name: "Cut & brake panel skins", stationId: sheetMetal.id, expectedMinutes: 70 },
      { itemId: panelSet.id, sequence: 2, name: "Lay insulation & close double-wall", stationId: panelDoorFab.id, expectedMinutes: 80 },
      { itemId: panelSet.id, sequence: 3, name: "Fit gaskets & trim", stationId: panelDoorFab.id, expectedMinutes: 35 },
    ])
    .returning();

  const doorSteps = await db
    .insert(routingSteps)
    .values([
      { itemId: doorSet.id, sequence: 1, name: "Cut door skins & frames", stationId: sheetMetal.id, expectedMinutes: 40 },
      { itemId: doorSet.id, sequence: 2, name: "Assemble doors, hinges & viewports", stationId: panelDoorFab.id, expectedMinutes: 55 },
    ])
    .returning();

  const coilSteps = await db
    .insert(routingSteps)
    .values([
      { itemId: coilSection.id, sequence: 1, name: "Expand tube into fin pack", stationId: coilLine.id, expectedMinutes: 65 },
      { itemId: coilSection.id, sequence: 2, name: "Braze headers & connections", stationId: coilLine.id, expectedMinutes: 50 },
      { itemId: coilSection.id, sequence: 3, name: "Pressure test & fit drain pan", stationId: coilLine.id, expectedMinutes: 45 },
    ])
    .returning();

  const fanSteps = await db
    .insert(routingSteps)
    .values([
      { itemId: fanSection.id, sequence: 1, name: "Mount wheel, shaft & bearings", stationId: fanMotorAsm.id, expectedMinutes: 60 },
      { itemId: fanSection.id, sequence: 2, name: "Fit motor, sheaves & belts", stationId: fanMotorAsm.id, expectedMinutes: 45 },
      { itemId: fanSection.id, sequence: 3, name: "Balance & spring-isolate assembly", stationId: fanMotorAsm.id, expectedMinutes: 55 },
    ])
    .returning();

  const ahuSteps = await db
    .insert(routingSteps)
    .values([
      { itemId: ahu.id, sequence: 1, name: "Set frame on line & verify dimensions", stationId: finalAsm.id, expectedMinutes: 40 },
      { itemId: ahu.id, sequence: 2, name: "Mount panels & access doors", stationId: finalAsm.id, expectedMinutes: 120 },
      { itemId: ahu.id, sequence: 3, name: "Install coil section & pipe connections", stationId: finalAsm.id, expectedMinutes: 90 },
      { itemId: ahu.id, sequence: 4, name: "Install fan section & filter rack", stationId: finalAsm.id, expectedMinutes: 85 },
      { itemId: ahu.id, sequence: 5, name: "Wire electrical & controls", stationId: electrical.id, expectedMinutes: 70 },
      { itemId: ahu.id, sequence: 6, name: "Leak test, run test & final QC", stationId: qcDock.id, expectedMinutes: 60 },
      { itemId: ahu.id, sequence: 7, name: "Crate & prep for dispatch", stationId: qcDock.id, expectedMinutes: 35 },
    ])
    .returning();

  // --- BOMs, with each line declaring WHICH step consumes it ---------------
  await db.insert(bomLines).values([
    // AHU is assembled from its five manufactured sub-assemblies + purchased parts
    { parentItemId: ahu.id, componentItemId: casingFrame.id, quantity: 1, consumedAtRoutingStepId: ahuSteps[0].id },
    { parentItemId: ahu.id, componentItemId: panelSet.id, quantity: 1, consumedAtRoutingStepId: ahuSteps[1].id },
    { parentItemId: ahu.id, componentItemId: doorSet.id, quantity: 1, consumedAtRoutingStepId: ahuSteps[1].id },
    { parentItemId: ahu.id, componentItemId: coilSection.id, quantity: 1, consumedAtRoutingStepId: ahuSteps[2].id },
    { parentItemId: ahu.id, componentItemId: fanSection.id, quantity: 1, consumedAtRoutingStepId: ahuSteps[3].id },
    { parentItemId: ahu.id, componentItemId: filterMedia.id, quantity: 8, consumedAtRoutingStepId: ahuSteps[3].id },
    { parentItemId: ahu.id, componentItemId: elecParts.id, quantity: 1, consumedAtRoutingStepId: ahuSteps[4].id },

    // Sub-assembly BOMs (purchased raw material)
    { parentItemId: casingFrame.id, componentItemId: galvSheet.id, quantity: 4, consumedAtRoutingStepId: frameSteps[0].id },
    { parentItemId: panelSet.id, componentItemId: galvSheet.id, quantity: 12, consumedAtRoutingStepId: panelSteps[0].id },
    { parentItemId: panelSet.id, componentItemId: insulation.id, quantity: 6, consumedAtRoutingStepId: panelSteps[1].id },
    { parentItemId: doorSet.id, componentItemId: galvSheet.id, quantity: 3, consumedAtRoutingStepId: doorSteps[0].id },
    { parentItemId: doorSet.id, componentItemId: insulation.id, quantity: 2, consumedAtRoutingStepId: doorSteps[0].id },
    { parentItemId: coilSection.id, componentItemId: copperTube.id, quantity: 180, consumedAtRoutingStepId: coilSteps[0].id },
    { parentItemId: coilSection.id, componentItemId: finStock.id, quantity: 25, consumedAtRoutingStepId: coilSteps[0].id },
    { parentItemId: fanSection.id, componentItemId: fanWheel.id, quantity: 1, consumedAtRoutingStepId: fanSteps[0].id },
    { parentItemId: fanSection.id, componentItemId: motor.id, quantity: 1, consumedAtRoutingStepId: fanSteps[1].id },
  ]);

  // --- Stock -----------------------------------------------------------------
  // Opening stock enters as RECEIPT movements through the engine, so balances and the
  // ledger agree from the first row. There is no direct write path to balances.
  const [stores] = await db
    .insert(inventoryLocations)
    .values({ code: "STORES", name: "Main stores" })
    .returning();

  // --- Vendors -------------------------------------------------------------
  const [kloeckner, beshert, fgm] = await db
    .insert(vendors)
    .values([
      { name: "Kloeckner Metals Corp - HTX", contactName: "R. Tan" },
      { name: "Beshert Steel Processing" },
      { name: "FGM - Pacesetter LLC" },
    ])
    .returning();

  /*
    Opening stock, received as identified batches.

    The sheet and the tube arrive on several pallets from the same heat, which is
    what actually happens and is the case worth showing: one mill cast, split
    across pallets, each with its own label. Issue takes the oldest pallet first,
    so the demo shows a part-used batch next to untouched ones.

    Two items are deliberately received WITHOUT a batch, as an opening balance. A
    system that pretends every unit of legacy stock has a heat number is lying, and
    the inventory screen says so in plain words rather than hiding the difference.
  */
  const lotted: {
    itemId: number;
    quantity: number;
    heat: string;
    batch: string;
    vendorId: number;
    po: string;
    bay: string;
    daysAgo: number;
  }[] = [
    { itemId: galvSheet.id, quantity: 40, heat: "EB7728", batch: "307290-1", vendorId: kloeckner.id, po: "260750", bay: "IN Bay 01", daysAgo: 21 },
    { itemId: galvSheet.id, quantity: 40, heat: "EB7728", batch: "307290-2", vendorId: kloeckner.id, po: "260750", bay: "IN Bay 01", daysAgo: 21 },
    { itemId: galvSheet.id, quantity: 40, heat: "EB7728", batch: "307290-3", vendorId: kloeckner.id, po: "260750", bay: "IN Bay 01", daysAgo: 21 },
    { itemId: galvSheet.id, quantity: 60, heat: "EB9014", batch: "311884-1", vendorId: beshert.id, po: "260812", bay: "IN Bay 02", daysAgo: 6 },
    { itemId: galvSheet.id, quantity: 40, heat: "EB9014", batch: "311884-2", vendorId: beshert.id, po: "260812", bay: "IN Bay 02", daysAgo: 6 },
    { itemId: insulation.id, quantity: 95, heat: "—", batch: "INS-4471", vendorId: fgm.id, po: "260744", bay: "IN Bay 04", daysAgo: 14 },
    { itemId: copperTube.id, quantity: 800, heat: "CU-88213", batch: "CU-88213-A", vendorId: fgm.id, po: "260771", bay: "Tube rack 2", daysAgo: 11 },
    { itemId: copperTube.id, quantity: 600, heat: "CU-90551", batch: "CU-90551-A", vendorId: fgm.id, po: "260803", bay: "Tube rack 2", daysAgo: 4 },
    { itemId: finStock.id, quantity: 180, heat: "AL-5521", batch: "FIN-5521", vendorId: fgm.id, po: "260771", bay: "Tube rack 3", daysAgo: 11 },
    { itemId: motor.id, quantity: 6, heat: "—", batch: "MTR-260801", vendorId: fgm.id, po: "260801", bay: "OUT Bay 15", daysAgo: 9 },
    { itemId: fanWheel.id, quantity: 4, heat: "—", batch: "WHL-260801", vendorId: fgm.id, po: "260801", bay: "OUT Bay 15", daysAgo: 9 },
  ];

  for (const lot of lotted) {
    await receiveStock({
      commandId: randomUUID(),
      itemId: lot.itemId,
      locationId: stores.id,
      quantity: lot.quantity,
      lot: {
        heatNumber: lot.heat === "—" ? null : lot.heat,
        batchNumber: lot.batch,
        vendorId: lot.vendorId,
        procurementReference: lot.po,
        storageLocation: lot.bay,
        receivedAt: new Date(Date.now() - lot.daysAgo * 86_400_000),
      },
    });
  }

  // Legacy stock: on the rack, counted, and with nothing behind it. Real, and the
  // screen is explicit about it rather than implying a traceability we do not have.
  for (const [itemId, qty] of [
    [filterMedia.id, 64],
    [elecParts.id, 5],
    [coilSection.id, 1],
  ] as [number, number][]) {
    await receiveStock({
      commandId: randomUUID(),
      itemId,
      locationId: stores.id,
      quantity: qty,
    });
  }

  /*
   * Stop here when seeding a clean floor.
   *
   * Everything above is the factory: stations, people, products, routings, bills
   * of materials and a stocked store. Everything below is work in progress —
   * orders part-built, steps signed off, blockers standing. For a demo where
   * somebody raises the first order themselves, the work in progress is exactly
   * what gets in the way.
   */
  if (process.argv.includes("--no-orders")) {
    console.log("");
    console.log("Clean floor seeded — stores stocked, nothing in progress.");
    console.log("Logins (password for all: password123):");
    console.log("  admin@thermal-corp.com       ADMIN");
    console.log("  supervisor@thermal-corp.com  SUPERVISOR");
    console.log("  forklift@thermal-corp.com    FORKLIFT");
    console.log("  worker1@..worker4@thermal-corp.com  WORKER");
    return;
  }

  // --- Work orders ---------------------------------------------------------
  const due = (days: number) => new Date(Date.now() + days * 86_400_000);

  const [wo1, wo2] = await db
    .insert(workOrders)
    .values([
      {
        orderNumber: "ORD-0001",
        itemId: ahu.id,
        customerId: customer.id,
        quantity: 1,
        dueDate: due(12),
        status: "PLANNED",
        createdByUserId: admin.id,
      },
      {
        orderNumber: "ORD-0002",
        itemId: ahu.id,
        customerId: customer.id,
        quantity: 2,
        dueDate: due(26),
        status: "PLANNED",
        createdByUserId: admin.id,
      },
    ])
    .returning();

  // Releasing spawns the whole sub-assembly tree automatically.
  await releaseWorkOrder(wo1.id, admin.id);
  await releaseWorkOrder(wo2.id, admin.id);

  // --- Put ORD-0001 into a realistic mid-build state -------------------------
  // Frame done, panels part-done, coil blocked on material, fan not started.
  const tree = await db.query.workOrders.findMany({
    where: eq(workOrders.parentWorkOrderId, wo1.id),
    with: { item: true, tasks: true },
  });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  for (const child of tree) {
    const tasks = child.tasks.sort((a, b) => a.sequence - b.sequence);

    if (child.item.sku === "SUB-FRAME-01") {
      for (const [i, t] of tasks.entries()) {
        await db
          .update(workOrderTasks)
          .set({
            status: "DONE",
            completedByUserId: wFrame.id,
            startedAt: hoursAgo(40 - i * 4),
            completedAt: hoursAgo(38 - i * 4),
          })
          .where(eq(workOrderTasks.id, t.id));
        await db.insert(timeEntries).values({
          workOrderTaskId: t.id,
          userId: wFrame.id,
          startedAt: hoursAgo(40 - i * 4),
          endedAt: hoursAgo(38 - i * 4),
          durationSeconds: 2 * 3600,
        });
      }
      await db.update(workOrders).set({ status: "DONE" }).where(eq(workOrders.id, child.id));

      /*
       * Hand the finished frame to the parent, the way finishing the last step
       * does in the app.
       *
       * Setting statuses directly is fine for making a floor look busy, but the
       * completion PATH is what produces the output and allocates it. Without
       * this the demo showed a sub-assembly with every step done sitting next to
       * a parent that was still short of it — a contradiction that reads as a
       * broken system rather than a seeded one.
       */
      await deliverCompletedSubAssembly({
        operationId: tasks[tasks.length - 1].id,
        actorUserId: wFrame.id,
      });
    }

    if (child.item.sku === "SUB-PANEL-01") {
      await db
        .update(workOrderTasks)
        .set({ status: "DONE", completedByUserId: wFrame.id, startedAt: hoursAgo(20), completedAt: hoursAgo(18) })
        .where(eq(workOrderTasks.id, tasks[0].id));
      await db.insert(timeEntries).values({
        workOrderTaskId: tasks[0].id,
        userId: wFrame.id,
        startedAt: hoursAgo(20),
        endedAt: hoursAgo(18),
        durationSeconds: 2 * 3600,
      });
      await db
        .update(workOrderTasks)
        .set({ status: "IN_PROGRESS", startedAt: hoursAgo(3) })
        .where(eq(workOrderTasks.id, tasks[1].id));
      await db.update(workOrders).set({ status: "IN_PROGRESS" }).where(eq(workOrders.id, child.id));
    }

    if (child.item.sku === "SUB-COIL-01") {
      const [leakCode] = await db
        .select()
        .from(reasonCodes)
        .where(eq(reasonCodes.code, "WAIT_MATERIAL"));
      await db
        .update(workOrderTasks)
        .set({
          status: "BLOCKED",
          blockedReasonCodeId: leakCode?.id ?? null,
          blockedNote: "Copper tube delivery short — 60 ft outstanding from vendor",
        })
        .where(eq(workOrderTasks.id, tasks[0].id));
      await db.update(workOrders).set({ status: "ON_HOLD" }).where(eq(workOrders.id, child.id));

      // The application raises this alert itself when a worker taps "Can't
      // continue". The seed sets the status directly, so it has to raise the
      // matching alert too, or the demo opens on an empty alerts page while a
      // step sits blocked.
      await raiseAlert({
        kind: "STEP_BLOCKED",
        workOrderTaskId: tasks[0].id,
        workOrderId: child.id,
        audienceStationId: null,
        title: `Blocked: ${tasks[0].name}`,
        detail: "Waiting on material — Copper tube delivery short, 60 ft outstanding from vendor",
        createdByUserId: wCoil.id,
      });
    }

    if (child.item.sku === "SUB-FAN-01") {
      await db
        .update(workOrderTasks)
        .set({ status: "IN_PROGRESS", startedAt: hoursAgo(3) })
        .where(eq(workOrderTasks.id, tasks[0].id));
      // An open clock, started well past the estimate on that step, so the
      // "running long" alert has something true to report.
      await db.insert(timeEntries).values({
        workOrderTaskId: tasks[0].id,
        userId: wFan.id,
        startedAt: hoursAgo(3),
      });
      await db.update(workOrders).set({ status: "IN_PROGRESS" }).where(eq(workOrders.id, child.id));
    }
  }

  await db.update(workOrders).set({ status: "IN_PROGRESS" }).where(eq(workOrders.id, wo1.id));

  // --- ORD-0002: the unit that gives every station something to do -----------
  //
  // Without this, half the demo accounts sign in to an empty screen. Not because
  // anything is broken — because every remaining step on ORD-0001 is genuinely
  // waiting on the one before it, and ORD-0002 has not been touched at all, so
  // only the first station in each chain has anything startable. That is honest
  // and it is a terrible first impression. Finishing the opening cut on ORD-0002
  // unblocks the frame line, and the same two commands would be run by a person
  // in ten seconds.
  const tree2 = await db.query.workOrders.findMany({
    where: eq(workOrders.parentWorkOrderId, wo2.id),
    with: { item: true, tasks: true },
  });

  for (const child of tree2) {
    const tasks = child.tasks.sort((a, b) => a.sequence - b.sequence);
    if (child.item.sku !== "SUB-FRAME-01") continue;

    // Step one of the frame is cut at Sheet Metal. Finishing it is what puts a
    // startable step in front of the welder.
    await db
      .update(workOrderTasks)
      .set({
        status: "DONE",
        completedByUserId: wFrame.id,
        startedAt: hoursAgo(6),
        completedAt: hoursAgo(5),
      })
      .where(eq(workOrderTasks.id, tasks[0].id));
    await db.insert(timeEntries).values({
      workOrderTaskId: tasks[0].id,
      userId: wFrame.id,
      startedAt: hoursAgo(6),
      endedAt: hoursAgo(5),
      durationSeconds: 3600,
    });

    // And one step is handed to a named person, because a queue nobody has been
    // put on does not show what assignment is for.
    await db
      .update(workOrderTasks)
      .set({
        assignedToUserId: wFrame.id,
        assignedByUserId: supervisor.id,
        assignedAt: hoursAgo(1),
      })
      .where(eq(workOrderTasks.id, tasks[1].id));
    await db.insert(taskEvents).values({
      workOrderTaskId: tasks[1].id,
      type: "ASSIGNED",
      actorUserId: supervisor.id,
      source: "HUMAN",
      payload: { assignedToUserId: wFrame.id, assignedToName: wFrame.name, previousUserId: null },
    });
    await raiseAlert({
      kind: "ASSIGNED_TO_YOU",
      workOrderTaskId: tasks[1].id,
      workOrderId: child.id,
      audienceUserId: wFrame.id,
      title: `${supervisor.name} gave you: ${tasks[1].name}`,
      detail: `${child.item.name} (${child.orderNumber}) at Frame Fab.`,
      createdByUserId: supervisor.id,
    });

    await db.update(workOrders).set({ status: "IN_PROGRESS" }).where(eq(workOrders.id, child.id));
  }

  // --- One worker on two machines at once ----------------------------------
  //
  // Seeded because the proration it demonstrates is invisible until it happens,
  // and "one operator, three machines, three hours per hour" is the failure the
  // timesheet is built to avoid. These two entries overlap by an hour, so the
  // charged column differs from the clock column and the split is legible.
  const fanTasks = await db.query.workOrderTasks.findMany({
    where: eq(workOrderTasks.status, "IN_PROGRESS"),
    limit: 2,
  });
  if (fanTasks.length >= 1) {
    await db.insert(timeEntries).values({
      workOrderTaskId: fanTasks[0].id,
      userId: wFan.id,
      startedAt: hoursAgo(9),
      endedAt: hoursAgo(7),
      durationSeconds: 7200,
    });
    if (fanTasks[1]) {
      await db.insert(timeEntries).values({
        workOrderTaskId: fanTasks[1].id,
        userId: wFan.id,
        startedAt: hoursAgo(8),
        endedAt: hoursAgo(7),
        durationSeconds: 3600,
      });
    }
  }

  await db.update(workOrders).set({ status: "IN_PROGRESS" }).where(eq(workOrders.id, wo2.id));

  console.log("\nSeed complete.");
  console.log("Logins (password for all: password123):");
  console.log("  admin@thermal-corp.com       ADMIN");
  console.log("  supervisor@thermal-corp.com  SUPERVISOR  (Final Assembly)");
  console.log("  worker1@thermal-corp.com     WORKER      (Frame Fab)");
  console.log("  worker2@thermal-corp.com     WORKER      (Coil Line)");
  console.log("  worker3@thermal-corp.com     WORKER      (Fan & Motor Assembly)");
  console.log("  worker4@thermal-corp.com     WORKER      (Final Assembly)");
  void wFinal;
  void electrical;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
