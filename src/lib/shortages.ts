import { eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  items,
  inventoryBalances,
  materialRequirements,
  workOrders,
  workOrderTasks,
} from "@/db/schema";
import type { Exec } from "@/lib/inventory";

export type Shortage = {
  itemId: number;
  sku: string;
  name: string;
  unit: string;
  /** Still needed across this order and everything under it. */
  required: number;
  /** On hand, minus what other orders have already reserved, minus anything on hold. */
  free: number;
  /** How much has to be bought. Always at least 1 — a covered line is not listed. */
  short: number;
};

/**
 * What this order cannot be built from today.
 *
 * Only bought-in parts are counted. A shortage of something we make is not a
 * shortage — it is a sub-assembly with its own order, its own steps and its own
 * shortages, and listing it here would tell a buyer to go and purchase a thing the
 * factory is already building.
 *
 * Free stock is counted across every location and against the whole plant's
 * reservations, so two orders wanting the last sheet are both told the truth
 * rather than each being promised it.
 */
export async function shortagesForOrder(
  workOrderId: number,
  exec: Exec = {}
): Promise<Shortage[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  // The order plus every sub-assembly beneath it, however deep.
  const orderIds: number[] = [workOrderId];
  for (let cursor = 0; cursor < orderIds.length; cursor++) {
    const children = await database
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.parentWorkOrderId, orderIds[cursor]));
    for (const c of children) orderIds.push(c.id);
  }

  const rows = await database
    .select({
      itemId: materialRequirements.itemId,
      sku: items.sku,
      name: items.name,
      unit: items.unitOfMeasure,
      procurementType: items.procurementType,
      requiredQty: materialRequirements.requiredQty,
      issuedQty: materialRequirements.issuedQty,
      returnedQty: materialRequirements.returnedQty,
      scrappedFromWipQty: materialRequirements.scrappedFromWipQty,
    })
    .from(materialRequirements)
    .innerJoin(workOrderTasks, eq(materialRequirements.operationId, workOrderTasks.id))
    .innerJoin(items, eq(materialRequirements.itemId, items.id))
    .where(inArray(workOrderTasks.workOrderId, orderIds));

  const wanted = new Map<number, Shortage>();
  for (const r of rows) {
    if (r.procurementType !== "PURCHASED") continue;
    const outstanding =
      r.requiredQty - (r.issuedQty - r.returnedQty - r.scrappedFromWipQty);
    if (outstanding <= 0) continue;

    const seen = wanted.get(r.itemId);
    if (seen) {
      seen.required += outstanding;
    } else {
      wanted.set(r.itemId, {
        itemId: r.itemId,
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        required: outstanding,
        free: 0,
        short: 0,
      });
    }
  }

  if (wanted.size === 0) return [];

  const balances = await database
    .select({
      itemId: inventoryBalances.itemId,
      free: sql<number>`coalesce(sum(
        ${inventoryBalances.onHand} - ${inventoryBalances.activeReserved} - ${inventoryBalances.heldQty}
      ), 0)::int`,
    })
    .from(inventoryBalances)
    .where(inArray(inventoryBalances.itemId, [...wanted.keys()]))
    .groupBy(inventoryBalances.itemId);

  const freeByItem = new Map(balances.map((b) => [b.itemId, b.free]));

  const short: Shortage[] = [];
  for (const line of wanted.values()) {
    line.free = Math.max(0, freeByItem.get(line.itemId) ?? 0);
    line.short = line.required - line.free;
    if (line.short > 0) short.push(line);
  }

  // Worst first: the buyer works down the list.
  return short.sort((a, b) => b.short - a.short);
}
