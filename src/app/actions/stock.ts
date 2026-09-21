"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { inventoryLocations, inventoryMovements, items, stockLots } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { CommandError, scrapStock } from "@/lib/inventory";

export type ScannedLot = {
  lotId: number;
  batchNumber: string;
  heatNumber: string | null;
  itemId: number;
  itemName: string;
  sku: string;
  unit: string;
  locationId: number;
  locationName: string;
  storageLocation: string | null;
  remaining: number;
};

/**
 * What is this pallet?
 *
 * Reads the batch off a scan and answers with everything printed on the label
 * plus what is actually left of it — because the number on the label is what was
 * received, and the handler standing at the rack needs what remains.
 */
export async function findLot(
  code: string
): Promise<{ ok: true; lot: ScannedLot } | { ok: false; error: string }> {
  try {
    await requireUser();
    const batch = String(code ?? "").trim();
    if (!batch || batch.length > 64) return { ok: false, error: "Scan a batch code" };

    const [lot] = await db
      .select({
        lotId: stockLots.id,
        batchNumber: stockLots.batchNumber,
        heatNumber: stockLots.heatNumber,
        storageLocation: stockLots.storageLocation,
        itemId: items.id,
        itemName: items.name,
        sku: items.sku,
        unit: items.unitOfMeasure,
      })
      .from(stockLots)
      .innerJoin(items, eq(items.id, stockLots.itemId))
      .where(eq(stockLots.batchNumber, batch));

    if (!lot) return { ok: false, error: `No batch on the system is labelled ${batch}` };

    // Where it physically is, and how much of it is left there. A lot can in
    // principle sit in more than one place; the one still holding stock is the
    // one the handler is standing at.
    const [where] = await db
      .select({
        locationId: inventoryMovements.locationId,
        locationName: inventoryLocations.name,
        remaining: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int`,
      })
      .from(inventoryMovements)
      .innerJoin(inventoryLocations, eq(inventoryLocations.id, inventoryMovements.locationId))
      .where(eq(inventoryMovements.lotId, lot.lotId))
      .groupBy(inventoryMovements.locationId, inventoryLocations.name)
      .orderBy(sql`coalesce(sum(${inventoryMovements.quantity}), 0) desc`)
      .limit(1);

    if (!where) return { ok: false, error: `${batch} has no stock movements on record` };

    return {
      ok: true,
      lot: {
        ...lot,
        // It matched on this value, so it is the batch number whatever the
        // column's nullability says.
        batchNumber: batch,
        locationId: where.locationId,
        locationName: where.locationName,
        remaining: where.remaining,
      },
    };
  } catch {
    return { ok: false, error: "Could not look that batch up" };
  }
}

const rejectRequest = z
  .object({
    commandId: z.uuid(),
    lotId: z.number().int().positive(),
    itemId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

/**
 * Write a scanned batch off as damaged.
 *
 * Open to any signed-in person, deliberately. The handler who lifts the pallet is
 * the one who finds it wet, and making them fetch a supervisor is how damage stops
 * being recorded at all — the same reasoning that lets a worker flag a step they
 * cannot continue. It is written down with their name against it, which is what
 * makes it answerable afterwards.
 */
export async function rejectStock(
  input: z.infer<typeof rejectRequest>
): Promise<
  { ok: true; scrapped: number; reservationsReleased: number } | { ok: false; error: string }
> {
  try {
    const user = await requireUser();
    const parsed = rejectRequest.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Say how many and why" };

    const { commandId, lotId, itemId, locationId, quantity, reason } = parsed.data;

    // The scan told the client which lot; the server checks it is that item's lot
    // rather than trusting a pair of ids that arrived together in one request.
    const [lot] = await db
      .select({ itemId: stockLots.itemId })
      .from(stockLots)
      .where(and(eq(stockLots.id, lotId), eq(stockLots.itemId, itemId)));
    if (!lot) return { ok: false, error: "That batch does not belong to that item" };

    const result = await scrapStock({
      commandId,
      itemId,
      locationId,
      quantity,
      lotId,
      reason,
      actorUserId: user.id,
    });

    revalidatePath("/", "layout");
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not write that off. Please try again." };
  }
}
