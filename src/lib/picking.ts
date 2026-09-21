import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  inventoryMovements, items, materialRequirements, stockLots, workOrderTasks,
} from "@/db/schema";
import { coverageFor, type Exec } from "@/lib/inventory";
import { satisfiedQuantityFor } from "@/lib/outputs";

/**
 * The pick list for one step.
 *
 * What the handler is standing there to collect, and how much of it they have
 * already scanned in. Starting a step no longer draws material, so this is the
 * list that turns "the job has begun" into "go and get these".
 */

export type PickLine = {
  requirementId: number;
  itemId: number;
  itemName: string;
  sku: string;
  unit: string;
  required: number;
  /** Net of returns and WIP scrap — what is actually on the bench. */
  taken: number;
  /** Committed to this step but still on the shelf. */
  reserved: number;
  /** Supplied by a child work order rather than from stock. */
  fromSubAssembly: number;
  /** Still to collect. Zero means this line is done. */
  outstanding: number;
};

export async function pickListFor(operationId: number, exec: Exec = {}): Promise<PickLine[]> {
  const database = exec.tx ?? exec.db ?? db;

  const reqs = await database
    .select({
      id: materialRequirements.id,
      itemId: materialRequirements.itemId,
      requiredQty: materialRequirements.requiredQty,
      itemName: items.name,
      sku: items.sku,
      unit: items.unitOfMeasure,
    })
    .from(materialRequirements)
    .innerJoin(items, eq(items.id, materialRequirements.itemId))
    .where(eq(materialRequirements.operationId, operationId))
    .orderBy(asc(materialRequirements.id));

  return Promise.all(
    reqs.map(async (r) => {
      const cover = await coverageFor(r.id, exec);
      const fromSubAssembly = await satisfiedQuantityFor(r.id, exec);
      const taken = cover.netIssued;
      return {
        requirementId: r.id,
        itemId: r.itemId,
        itemName: r.itemName,
        sku: r.sku,
        unit: r.unit,
        required: r.requiredQty,
        taken,
        reserved: cover.activeReserved,
        fromSubAssembly,
        outstanding: Math.max(0, r.requiredQty - taken - fromSubAssembly),
      };
    })
  );
}

/** Everything still to collect across a step — the number on the button. */
export async function outstandingPickCount(operationId: number, exec: Exec = {}): Promise<number> {
  const lines = await pickListFor(operationId, exec);
  return lines.reduce((n, l) => n + l.outstanding, 0);
}

export type ScannedPickLot = {
  lotId: number;
  batchNumber: string;
  heatNumber: string | null;
  storageLocation: string | null;
  itemId: number;
  itemName: string;
  remaining: number;
};

/**
 * Resolve a scanned batch for picking against a step.
 *
 * Deliberately returns the lot even when it is the wrong item — the caller can
 * then say "that is Copper Tube, this step needs Galvanized Sheet", which is a far
 * more useful thing to tell somebody holding a pallet than "not found".
 */
export async function findPickLot(
  batchNumber: string,
  locationId: number,
  exec: Exec = {}
): Promise<ScannedPickLot | null> {
  const database = exec.tx ?? exec.db ?? db;
  const [lot] = await database
    .select({
      lotId: stockLots.id,
      batchNumber: stockLots.batchNumber,
      heatNumber: stockLots.heatNumber,
      storageLocation: stockLots.storageLocation,
      itemId: stockLots.itemId,
      itemName: items.name,
    })
    .from(stockLots)
    .innerJoin(items, eq(items.id, stockLots.itemId))
    .where(eq(stockLots.batchNumber, batchNumber.trim()));
  if (!lot?.batchNumber) return null;

  const [sum] = await database
    .select({ remaining: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int` })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.lotId, lot.lotId),
        eq(inventoryMovements.locationId, locationId)
      )
    );

  return { ...lot, batchNumber: lot.batchNumber, remaining: sum?.remaining ?? 0 };
}

/** The step, for checking it is running before anything is drawn against it. */
export async function operationForPick(operationId: number, exec: Exec = {}) {
  const database = exec.tx ?? exec.db ?? db;
  const [task] = await database
    .select({
      id: workOrderTasks.id,
      status: workOrderTasks.status,
      stationId: workOrderTasks.stationId,
      assignedToUserId: workOrderTasks.assignedToUserId,
      name: workOrderTasks.name,
    })
    .from(workOrderTasks)
    .where(eq(workOrderTasks.id, operationId));
  return task ?? null;
}
