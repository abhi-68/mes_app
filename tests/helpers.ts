import { db } from "../src/db";
import {
  items,
  users,
  stations,
  customers,
  workOrders,
  workOrderTasks,
  routingSteps,
  bomLines,
  inventoryLocations,
  inventoryBalances,
  inventoryMovements,
  inventoryHolds,
  materialRequirements,
  reservations,
  processedCommands,
  operationOutputs,
  dispositionRecords,
  operationDependencies,
  taskEvents,
  timeEntries,
  timeEntryAdjustments,
  qualityEvents,
  reasonCodes,
  alerts,
  stockLots,
  vendors,
  deliveryNotes,
} from "../src/db/schema";

/**
 * Single source of truth for test cleanup, in foreign-key order.
 *
 * This lives in one place because it drifted once: adding inventory_holds,
 * operation_outputs and disposition_records broke an older test file whose own
 * delete list had not been updated, and every test in it failed on a FK violation.
 */
export async function resetDatabase(): Promise<void> {
  if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
    throw new Error("Refusing to reset: DATABASE_URL must point at mes_test");
  }

  await db.delete(alerts);
  // Delivery notes reference work orders, so they clear before them.
  await db.delete(deliveryNotes);

  await db.delete(operationDependencies);
  await db.delete(dispositionRecords);
  await db.delete(operationOutputs);
  await db.delete(inventoryHolds);
  // Movements reference lots, so they go first; lots reference vendors.
  await db.delete(inventoryMovements);
  await db.delete(reservations);
  await db.delete(materialRequirements);
  await db.delete(inventoryBalances);
  await db.delete(inventoryLocations);
  await db.delete(stockLots);
  await db.delete(vendors);
  await db.delete(processedCommands);
  await db.delete(timeEntryAdjustments);
  await db.delete(timeEntries);
  await db.delete(qualityEvents);
  await db.delete(taskEvents);
  await db.delete(workOrderTasks);
  await db.delete(workOrders);
  // bom_lines.consumed_at_routing_step_id references routing_steps, so it goes first.
  await db.delete(bomLines);
  await db.delete(routingSteps);
  await db.delete(items);
  await db.delete(reasonCodes);
  await db.delete(customers);
  await db.delete(users);
  await db.delete(stations);
}

/** Monotonic command ids for tests. */
export const uid = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}-${Date.now()}`;
})();
