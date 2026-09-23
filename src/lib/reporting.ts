import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  deliveryNotes,
  items,
  materialRequirements,
  qualityEvents,
  workOrders,
} from "@/db/schema";
import { prorate } from "@/lib/timesheets";

export type AverageRow = {
  key: string;
  label: string;
  sublabel: string | null;
  runs: number;
  avgMinutes: number;
  estimateMinutes: number | null;
  /** avg vs estimate, e.g. 1.2 = taking 20% longer than estimated. */
  ratio: number | null;
};

/**
 * Effective duration for a time entry = its most recent supervisor adjustment if one
 * exists, otherwise the originally recorded duration. The original row is never
 * overwritten, so this is always reconstructable.
 */
function effectiveSeconds(entry: {
  durationSeconds: number | null;
  adjustments: { newDurationSeconds: number; id: number }[];
}): number | null {
  if (entry.adjustments.length > 0) {
    const latest = [...entry.adjustments].sort((a, b) => b.id - a.id)[0];
    return latest.newDurationSeconds;
  }
  return entry.durationSeconds;
}

/**
 * Every entry, with the seconds this report should count for each one.
 *
 * Reports must use CHARGED time, not recorded time. A worker minding three
 * machines records three full hours per hour on the clock; averaging that would
 * say every step takes three times as long as it does, and the estimates built
 * from those averages would be wrong in the same direction forever.
 *
 * Open entries are loaded but never reported on. They are here because they still
 * compete for the worker's attention: an entry that ran alongside something still
 * running has genuinely shared that time, and leaving the open one out of the pool
 * would charge the finished one for all of it.
 */
async function loadChargedEntries() {
  const entries = await db.query.timeEntries.findMany({
    with: {
      adjustments: true,
      user: true,
      task: { with: { station: true, workOrder: { with: { item: true } } } },
    },
  });

  const charged = prorate(
    entries.map((e) => ({
      id: e.id,
      userId: e.userId,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      durationSeconds: e.durationSeconds,
      adjustedSeconds:
        e.adjustments.length > 0
          ? [...e.adjustments].sort((a, b) => b.id - a.id)[0].newDurationSeconds
          : null,
    }))
  );

  return entries
    .filter((e) => e.endedAt !== null)
    .map((e) => ({ ...e, chargedSeconds: charged.get(e.id)?.chargedSeconds ?? null }));
}

function summarise(
  groups: Map<string, { label: string; sublabel: string | null; estimate: number | null; values: number[] }>
): AverageRow[] {
  return [...groups.entries()]
    .map(([key, g]) => {
      const avgMinutes =
        g.values.reduce((s, v) => s + v, 0) / Math.max(1, g.values.length) / 60;
      return {
        key,
        label: g.label,
        sublabel: g.sublabel,
        runs: g.values.length,
        avgMinutes: Math.round(avgMinutes),
        estimateMinutes: g.estimate,
        ratio: g.estimate && g.estimate > 0 ? avgMinutes / g.estimate : null,
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

/** Average actual time per named step, compared against its estimate. */
export async function averagesByStep(): Promise<AverageRow[]> {
  const entries = await loadChargedEntries();
  const groups = new Map<
    string,
    { label: string; sublabel: string | null; estimate: number | null; values: number[] }
  >();

  for (const e of entries) {
    const secs = e.chargedSeconds;
    if (secs == null) continue;
    const key = `${e.task.workOrder.item.sku}::${e.task.name}`;
    const g = groups.get(key) ?? {
      label: e.task.name,
      sublabel: e.task.workOrder.item.name,
      estimate: e.task.expectedMinutes,
      values: [],
    };
    g.values.push(secs);
    groups.set(key, g);
  }
  return summarise(groups);
}

/** Average actual time per station — where the hours are really going. */
export async function averagesByStation(): Promise<AverageRow[]> {
  const entries = await loadChargedEntries();
  const groups = new Map<
    string,
    { label: string; sublabel: string | null; estimate: number | null; values: number[] }
  >();

  for (const e of entries) {
    const secs = e.chargedSeconds;
    if (secs == null) continue;
    const key = e.task.station?.name ?? "Unassigned";
    const g = groups.get(key) ?? { label: key, sublabel: null, estimate: null, values: [] };
    g.values.push(secs);
    groups.set(key, g);
  }
  return summarise(groups);
}

/** Average time per person. Shown to managers only. */
export async function averagesByWorker(): Promise<AverageRow[]> {
  const entries = await loadChargedEntries();
  const groups = new Map<
    string,
    { label: string; sublabel: string | null; estimate: number | null; values: number[] }
  >();

  for (const e of entries) {
    const secs = e.chargedSeconds;
    if (secs == null) continue;
    const key = String(e.userId);
    const g = groups.get(key) ?? {
      label: e.user.name,
      sublabel: null,
      estimate: null,
      values: [],
    };
    g.values.push(secs);
    groups.set(key, g);
  }
  return summarise(groups);
}

export type QualityRow = {
  label: string;
  type: string;
  quantity: number;
  occurrences: number;
};

/** Scrap and rework grouped by reason — the Pareto that says what to fix first. */
export async function qualityPareto(): Promise<QualityRow[]> {
  const events = await db.query.qualityEvents.findMany({
    with: { reasonCode: true },
  });

  const groups = new Map<string, QualityRow>();
  for (const e of events) {
    const label = e.reasonCode?.label ?? "No reason given";
    const key = `${e.type}::${label}`;
    const g = groups.get(key) ?? { label, type: e.type, quantity: 0, occurrences: 0 };
    g.quantity += e.quantity;
    g.occurrences += 1;
    groups.set(key, g);
  }

  return [...groups.values()].sort((a, b) => b.quantity - a.quantity);
}

/** Total hours charged to jobs, for the header stat. Shared time counted once. */
export async function totalRecordedHours(): Promise<number> {
  const entries = await loadChargedEntries();
  const total = entries.reduce((s, e) => s + (e.chargedSeconds ?? 0), 0);
  return Math.round((total / 3600) * 10) / 10;
}

export async function qualityEventCount(): Promise<number> {
  const rows = await db.select({ id: qualityEvents.id }).from(qualityEvents);
  return rows.length;
}

export type MaterialUsedRow = {
  itemId: number;
  name: string;
  sku: string;
  unit: string;
  issued: number;
  returned: number;
  scrapped: number;
  /** What was actually consumed: issued, less anything handed back or written off. */
  used: number;
};

/**
 * What the floor has actually consumed, from the movement ledger rather than from
 * what the bills of materials said it would take. The gap between the two is the
 * number worth knowing.
 */
export async function materialsUsed(): Promise<MaterialUsedRow[]> {
  const rows = await db
    .select({
      itemId: items.id,
      name: items.name,
      sku: items.sku,
      unit: items.unitOfMeasure,
      issued: sql<number>`coalesce(sum(${materialRequirements.issuedQty}), 0)::int`,
      returned: sql<number>`coalesce(sum(${materialRequirements.returnedQty}), 0)::int`,
      scrapped: sql<number>`coalesce(sum(${materialRequirements.scrappedFromWipQty}), 0)::int`,
    })
    .from(materialRequirements)
    .innerJoin(items, eq(materialRequirements.itemId, items.id))
    .groupBy(items.id, items.name, items.sku, items.unitOfMeasure);

  return rows
    // A sheet written off at the bench did not go into the product. Counting it as
    // used would say the job consumed more than it did and hide the waste.
    .map((r) => ({ ...r, used: r.issued - r.returned - r.scrapped }))
    .filter((r) => r.issued > 0)
    .sort((a, b) => b.used - a.used);
}

export type DeliveredRow = {
  orderNumber: string;
  itemName: string;
  customerName: string | null;
  quantity: number;
  status: string;
  shippedAt: Date | null;
};

/** Units that have left the building, newest first. */
export async function productsDelivered(): Promise<DeliveredRow[]> {
  return db
    .select({
      orderNumber: workOrders.orderNumber,
      itemName: items.name,
      customerName: customers.name,
      quantity: workOrders.quantity,
      status: sql<string>`${workOrders.status}::text`,
      shippedAt: deliveryNotes.deliveredAt,
    })
    .from(workOrders)
    .innerJoin(items, eq(workOrders.itemId, items.id))
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .leftJoin(deliveryNotes, eq(deliveryNotes.workOrderId, workOrders.id))
    .where(inArray(workOrders.status, ["IN_TRANSIT", "SHIPPED"]))
    .orderBy(desc(workOrders.id));
}

export { effectiveSeconds };
