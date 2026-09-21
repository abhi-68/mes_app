import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb } from "@/db";
import * as schema from "@/db/schema";
import {
  inventoryBalances,
  inventoryMovements,
  inventoryHolds,
  materialRequirements,
  reservations,
  processedCommands,
  stockLots,
  vendors,
  items,
} from "@/db/schema";

/**
 * Inventory engine — IMPL-SPEC rev 3.
 *
 * Every public function here is a COMMAND. Commands are:
 *   - idempotent by `commandId` (database-enforced, §6)
 *   - atomic: all effects commit in one transaction, or none do (§6)
 *   - guarded: state guards apply independently of command identity (§6.2)
 *
 * Balances are locked with SELECT ... FOR UPDATE before any decrement, so two
 * concurrent commands cannot both spend the same stock.
 */

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Where a command runs.
 *
 *   {}          -> opens its own transaction on the default database
 *   { db }      -> opens its own transaction on that database
 *   { tx }      -> JOINS the caller's transaction and opens none
 *
 * The `tx` form is what lets a task action commit its status change, its material
 * issue, its labour effect and its event together, so a failure cannot leave the
 * task complete while the issue rolled back.
 */
export type Exec = { db?: Db; tx?: Tx };

function run<T>(exec: Exec, body: (tx: Tx) => Promise<T>): Promise<T> {
  if (exec.tx) return body(exec.tx);
  return (exec.db ?? defaultDb).transaction(body);
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INSUFFICIENT_STOCK"
      | "ON_HOLD"
      | "NOT_RESERVED_TO_YOU"
      | "RESERVATION_EXHAUSTED"
      | "DUPLICATE_BATCH"
      | "COMMAND_ID_REUSED"
      | "STATE_GUARD"
      | "NOT_FOUND"
      /** An operation dependency is not yet satisfied (spec §2). */
      | "DEPENDENCY"
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 64);
}

/**
 * Replay protection. Returns "replay" when this exact command already ran, and throws
 * when the same id arrives with a different payload (§6.4).
 *
 * NOTE: a *new* command id does NOT bypass state guards (§6.2). Guards are checked by
 * each command separately, after this returns "fresh".
 */
async function claimCommand(
  tx: Tx,
  commandId: string,
  commandType: string,
  payload: unknown
): Promise<"fresh" | "replay"> {
  const payloadHash = hashPayload(payload);
  const existing = await tx
    .select()
    .from(processedCommands)
    .where(eq(processedCommands.commandId, commandId));

  if (existing.length > 0) {
    if (existing[0].payloadHash !== payloadHash) {
      throw new CommandError(
        `Command id ${commandId} was already used with different arguments`,
        "COMMAND_ID_REUSED"
      );
    }
    return "replay";
  }

  await tx.insert(processedCommands).values({ commandId, commandType, payloadHash });
  return "fresh";
}

/** Locks the balance row for this item+location, creating it at zero if absent. */
async function lockBalance(tx: Tx, itemId: number, locationId: number) {
  const existing = await tx
    .select()
    .from(inventoryBalances)
    .where(
      and(eq(inventoryBalances.itemId, itemId), eq(inventoryBalances.locationId, locationId))
    )
    .for("update");

  if (existing.length > 0) return existing[0];

  await tx
    .insert(inventoryBalances)
    .values({ itemId, locationId, onHand: 0, activeReserved: 0 })
    .onConflictDoNothing();

  const [row] = await tx
    .select()
    .from(inventoryBalances)
    .where(
      and(eq(inventoryBalances.itemId, itemId), eq(inventoryBalances.locationId, locationId))
    )
    .for("update");
  return row;
}

// ---------------------------------------------------------------------------
// Coverage and availability (§4)
// ---------------------------------------------------------------------------

export type Coverage = {
  required: number;
  netIssued: number;
  activeReserved: number;
  uncovered: number;
};

/**
 * uncovered = max(0, required − netIssued − activeReserved)
 * netIssued  = issued − returned − scrappedFromWip
 *
 * Counting issued material is what stops a fully-issued requirement reporting a
 * phantom shortage, and is why ResumeOperation cannot re-issue.
 */
export async function coverageFor(requirementId: number, exec: Exec = {}): Promise<Coverage> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const [req] = await database
    .select()
    .from(materialRequirements)
    .where(eq(materialRequirements.id, requirementId));
  if (!req) throw new CommandError("Requirement not found", "NOT_FOUND");

  const [{ reserved }] = await database
    .select({ reserved: sql<number>`coalesce(sum(${reservations.outstandingQty}), 0)::int` })
    .from(reservations)
    .where(eq(reservations.requirementId, requirementId));

  const netIssued = req.issuedQty - req.returnedQty - req.scrappedFromWipQty;
  return {
    required: req.requiredQty,
    netIssued,
    activeReserved: reserved,
    uncovered: Math.max(0, req.requiredQty - netIssued - reserved),
  };
}

/**
 * availableNow = onHand − activeReserved − heldQty.
 *
 * Held stock is NOT available. Omitting heldQty reports 5 motors available when all 5
 * are on quality hold, and an unreserved issue would then take them.
 */
export async function availableNow(
  itemId: number,
  locationId: number,
  exec: Exec = {}
): Promise<number> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(inventoryBalances)
    .where(
      and(eq(inventoryBalances.itemId, itemId), eq(inventoryBalances.locationId, locationId))
    );
  if (!row) return 0;
  return row.onHand - row.activeReserved - row.heldQty;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Bring stock in.
 *
 * `lot` is optional and its absence is meaningful rather than sloppy: a stock count
 * correction or an opening balance genuinely has no supplier batch behind it. When it
 * IS supplied, a stock_lots row is created and the receipt movement carries its id,
 * which is the only reason a heat number can be traced to a finished unit later.
 */
export async function receiveStock(
  input: {
    commandId: string;
    itemId: number;
    locationId: number;
    quantity: number;
    actorUserId?: number;
    lot?: {
      heatNumber?: string | null;
      batchNumber?: string | null;
      vendorId?: number | null;
      procurementReference?: string | null;
      storageLocation?: string | null;
      receivedAt?: Date;
      notes?: string | null;
    };
  },
  exec: Exec = {}
): Promise<{ lotId: number | null }> {
  let lotId: number | null = null;

  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReceiveStock", input)) === "replay") {
      // A replay must return the lot the FIRST attempt created, not null, or a caller
      // printing a label would print one for a lot that does not exist.
      const [prior] = await tx
        .select({ lotId: inventoryMovements.lotId })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.commandId, input.commandId));
      lotId = prior?.lotId ?? null;
      return;
    }

    if (input.lot) {
      const batch = input.lot.batchNumber?.trim() || null;
      if (batch) {
        // Batch numbers are scanned, so a duplicate would make a scan ambiguous. The
        // unique index would refuse it anyway; this turns that into a sentence.
        const [clash] = await tx
          .select({ id: stockLots.id })
          .from(stockLots)
          .where(eq(stockLots.batchNumber, batch));
        if (clash) {
          throw new CommandError(
            `Batch ${batch} already exists — a batch number has to point at one lot or a scan cannot resolve it`,
            "DUPLICATE_BATCH"
          );
        }
      }

      const [created] = await tx
        .insert(stockLots)
        .values({
          itemId: input.itemId,
          heatNumber: input.lot.heatNumber?.trim() || null,
          batchNumber: batch,
          vendorId: input.lot.vendorId ?? null,
          procurementReference: input.lot.procurementReference?.trim() || null,
          storageLocation: input.lot.storageLocation?.trim() || null,
          receivedAt: input.lot.receivedAt ?? new Date(),
          notes: input.lot.notes?.trim() || null,
        })
        .returning();
      lotId = created.id;
    }

    const balance = await lockBalance(tx, input.itemId, input.locationId);
    await tx
      .update(inventoryBalances)
      .set({ onHand: balance.onHand + input.quantity })
      .where(eq(inventoryBalances.id, balance.id));

    await tx.insert(inventoryMovements).values({
      itemId: input.itemId,
      locationId: input.locationId,
      type: "RECEIPT",
      quantity: input.quantity,
      lotId,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });

  return { lotId };
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

export type LotBalance = {
  lotId: number;
  heatNumber: string | null;
  batchNumber: string | null;
  vendorName: string | null;
  procurementReference: string | null;
  storageLocation: string | null;
  receivedAt: Date;
  received: number;
  /** Signed sum of every movement carrying this lot, at this location. */
  remaining: number;
};

/**
 * What is left of each lot of one item at one location, oldest first.
 *
 * Derived from the ledger rather than stored. Summing signed movements is the whole
 * point: there is no second number that can disagree with the balance, because there
 * is no second number.
 *
 * NOTE the deliberate gap: lot remainders sum to the on-hand balance only when every
 * movement carries a lot. Stock received before lot tracking, and adjustments that
 * belong to no batch, are unlotted — `unlottedRemaining` reports them separately so a
 * screen can show the difference instead of quietly losing it.
 */
export async function lotsFor(
  itemId: number,
  locationId: number,
  exec: Exec = {}
): Promise<{ lots: LotBalance[]; unlottedRemaining: number }> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  const rows = await database
    .select({
      lotId: stockLots.id,
      heatNumber: stockLots.heatNumber,
      batchNumber: stockLots.batchNumber,
      vendorName: vendors.name,
      procurementReference: stockLots.procurementReference,
      storageLocation: stockLots.storageLocation,
      receivedAt: stockLots.receivedAt,
      received: sql<number>`coalesce(sum(case when ${inventoryMovements.quantity} > 0 then ${inventoryMovements.quantity} else 0 end), 0)::int`,
      remaining: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int`,
    })
    .from(stockLots)
    .leftJoin(vendors, eq(vendors.id, stockLots.vendorId))
    .innerJoin(
      inventoryMovements,
      and(
        eq(inventoryMovements.lotId, stockLots.id),
        eq(inventoryMovements.locationId, locationId)
      )
    )
    .where(eq(stockLots.itemId, itemId))
    .groupBy(
      stockLots.id,
      stockLots.heatNumber,
      stockLots.batchNumber,
      vendors.name,
      stockLots.procurementReference,
      stockLots.storageLocation,
      stockLots.receivedAt
    )
    .orderBy(asc(stockLots.receivedAt), asc(stockLots.id));

  const [{ total } = { total: 0 }] = await database
    .select({
      total: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.itemId, itemId),
        eq(inventoryMovements.locationId, locationId),
        sql`${inventoryMovements.lotId} is null`
      )
    );

  return { lots: rows.map((r) => ({ ...r })), unlottedRemaining: total };
}

/** Find a lot by the code on its label. What a barcode scan resolves. */
export async function lotByBatch(
  batchNumber: string,
  exec: Exec = {}
): Promise<typeof stockLots.$inferSelect | null> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(stockLots)
    .where(eq(stockLots.batchNumber, batchNumber.trim()));
  return row ?? null;
}

/**
 * Which lots went into an operation — the question a customer quality query becomes.
 *
 * Reads the issue movements against that operation's requirements. Returns unlotted
 * issues as a count rather than hiding them, because "we do not know" is the honest
 * answer for stock that predates the lot and is far better than an incomplete list
 * presented as complete.
 */
export async function lotsConsumedBy(
  operationId: number,
  exec: Exec = {}
): Promise<{
  lots: { lotId: number; heatNumber: string | null; batchNumber: string | null; itemName: string; quantity: number }[];
  unlottedQuantity: number;
}> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  const reqs = await database
    .select({ id: materialRequirements.id })
    .from(materialRequirements)
    .where(eq(materialRequirements.operationId, operationId));
  if (reqs.length === 0) return { lots: [], unlottedQuantity: 0 };
  const reqIds = reqs.map((r) => r.id);

  const lotted = await database
    .select({
      lotId: stockLots.id,
      heatNumber: stockLots.heatNumber,
      batchNumber: stockLots.batchNumber,
      itemName: items.name,
      quantity: sql<number>`coalesce(-sum(${inventoryMovements.quantity}), 0)::int`,
    })
    .from(inventoryMovements)
    .innerJoin(stockLots, eq(stockLots.id, inventoryMovements.lotId))
    .innerJoin(items, eq(items.id, inventoryMovements.itemId))
    .where(
      and(
        inArray(inventoryMovements.requirementId, reqIds),
        eq(inventoryMovements.type, "ISSUE"),
        isNotNull(inventoryMovements.lotId)
      )
    )
    .groupBy(stockLots.id, stockLots.heatNumber, stockLots.batchNumber, items.name);

  const [{ total } = { total: 0 }] = await database
    .select({ total: sql<number>`coalesce(-sum(${inventoryMovements.quantity}), 0)::int` })
    .from(inventoryMovements)
    .where(
      and(
        inArray(inventoryMovements.requirementId, reqIds),
        eq(inventoryMovements.type, "ISSUE"),
        sql`${inventoryMovements.lotId} is null`
      )
    );

  return { lots: lotted, unlottedQuantity: total };
}

/**
 * Split a quantity across lots, oldest first.
 *
 * Returns one entry per lot drawn from, and a remainder for whatever no lot covers —
 * which is unlotted stock, and is issued as a single movement with a null lot rather
 * than being refused. Refusing it would make lot tracking a breaking change for every
 * unit of stock received before it existed.
 */
async function allocateAcrossLots(
  tx: Tx,
  itemId: number,
  locationId: number,
  quantity: number
): Promise<{ lotId: number | null; quantity: number }[]> {
  const rows = await tx
    .select({
      lotId: stockLots.id,
      remaining: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int`,
    })
    .from(stockLots)
    .innerJoin(
      inventoryMovements,
      and(
        eq(inventoryMovements.lotId, stockLots.id),
        eq(inventoryMovements.locationId, locationId)
      )
    )
    .where(eq(stockLots.itemId, itemId))
    .groupBy(stockLots.id, stockLots.receivedAt)
    .orderBy(asc(stockLots.receivedAt), asc(stockLots.id));

  const draws: { lotId: number | null; quantity: number }[] = [];
  let left = quantity;

  for (const row of rows) {
    if (left === 0) break;
    const take = Math.min(left, Math.max(0, row.remaining));
    if (take === 0) continue;
    draws.push({ lotId: row.lotId, quantity: take });
    left -= take;
  }

  if (left > 0) draws.push({ lotId: null, quantity: left });
  return draws;
}

/**
 * Reserve stock to ONE material requirement (§2 — scoped to the requirement, not the
 * order, so two operations in one order cannot both claim the same stock).
 *
 * Partial reservation is legitimate: requiring 10 when 6 are free reserves 6 and leaves
 * an uncovered requirement of 4. Shortage is a normal state, not an error.
 */
export async function reserveForRequirement(
  input: {
    commandId: string;
    requirementId: number;
    itemId: number;
    locationId: number;
    quantity: number;
  },
  exec: Exec = {}
): Promise<{ reserved: number }> {
  let reserved = 0;

  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReserveForRequirement", input)) === "replay") {
      const [existing] = await tx
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.requirementId, input.requirementId),
            eq(reservations.itemId, input.itemId)
          )
        );
      reserved = existing?.outstandingQty ?? 0;
      return;
    }

    const balance = await lockBalance(tx, input.itemId, input.locationId);
    // Held stock can be neither reserved nor issued, by anyone.
    const free = balance.onHand - balance.activeReserved - balance.heldQty;
    reserved = Math.max(0, Math.min(input.quantity, free));
    if (reserved === 0) return;

    await tx
      .update(inventoryBalances)
      .set({ activeReserved: balance.activeReserved + reserved })
      .where(eq(inventoryBalances.id, balance.id));

    const [existing] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.requirementId, input.requirementId),
          eq(reservations.itemId, input.itemId),
          eq(reservations.locationId, input.locationId)
        )
      );

    if (existing) {
      await tx
        .update(reservations)
        .set({ outstandingQty: existing.outstandingQty + reserved })
        .where(eq(reservations.id, existing.id));
    } else {
      await tx.insert(reservations).values({
        requirementId: input.requirementId,
        itemId: input.itemId,
        locationId: input.locationId,
        outstandingQty: reserved,
      });
    }
  });

  return { reserved };
}

/**
 * Issue material AGAINST A RESERVATION owned by this requirement.
 *
 * The guard is deliberately NOT `onHand − activeReserved >= qty`. That condition rejects
 * the reservation's rightful owner: 10 on hand all reserved to A gives 10 − 10 = 0, so A
 * could never draw its own stock. Ownership is verified instead, and the reservation's
 * outstanding quantity is the limit.
 */
export async function issueAgainstReservation(
  input: {
    commandId: string;
    requirementId: number;
    itemId: number;
    locationId: number;
    quantity: number;
    /**
     * The batch the handler actually scanned off the rack.
     *
     * Given, the whole quantity is drawn from that lot and the movement is marked
     * as confirmed. Omitted, the oldest lots are drawn instead and the movement is
     * marked ASSUMED — because nobody looked, and a trace that cannot tell the two
     * apart is worse than none.
     */
    lotId?: number | null;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "IssueAgainstReservation", input)) === "replay")
      return;

    const balance = await lockBalance(tx, input.itemId, input.locationId);

    const [reservation] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.requirementId, input.requirementId),
          eq(reservations.itemId, input.itemId),
          eq(reservations.locationId, input.locationId)
        )
      )
      .for("update");

    if (!reservation) {
      throw new CommandError(
        "This stock is not reserved to that requirement",
        "NOT_RESERVED_TO_YOU"
      );
    }
    if (reservation.outstandingQty < input.quantity) {
      throw new CommandError(
        `Reservation holds ${reservation.outstandingQty}, cannot issue ${input.quantity}`,
        "RESERVATION_EXHAUSTED"
      );
    }
    if (balance.onHand - balance.heldQty < input.quantity) {
      throw new CommandError(
        balance.heldQty > 0
          ? `${balance.heldQty} of ${balance.onHand} on hand is on quality hold; only ${
              balance.onHand - balance.heldQty
            } usable`
          : `Only ${balance.onHand} on hand, cannot issue ${input.quantity}`,
        balance.heldQty > 0 ? "ON_HOLD" : "INSUFFICIENT_STOCK"
      );
    }

    // onHand, activeReserved and the reservation move together.
    await tx
      .update(inventoryBalances)
      .set({
        onHand: balance.onHand - input.quantity,
        activeReserved: balance.activeReserved - input.quantity,
      })
      .where(eq(inventoryBalances.id, balance.id));

    await tx
      .update(reservations)
      .set({ outstandingQty: reservation.outstandingQty - input.quantity })
      .where(eq(reservations.id, reservation.id));

    const [req] = await tx
      .select()
      .from(materialRequirements)
      .where(eq(materialRequirements.id, input.requirementId));
    await tx
      .update(materialRequirements)
      .set({ issuedQty: req.issuedQty + input.quantity })
      .where(eq(materialRequirements.id, input.requirementId));

    // A SCANNED pick comes from the one batch in the handler's hands.
    if (input.lotId) {
      const [lot] = await tx
        .select({
          remaining: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int`,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.lotId, input.lotId),
            eq(inventoryMovements.locationId, input.locationId)
          )
        );
      const remaining = lot?.remaining ?? 0;
      if (remaining < input.quantity) {
        throw new CommandError(
          `That batch has only ${remaining} left`,
          "INSUFFICIENT_STOCK"
        );
      }

      await tx.insert(inventoryMovements).values({
        itemId: input.itemId,
        locationId: input.locationId,
        type: "ISSUE",
        quantity: -input.quantity,
        requirementId: input.requirementId,
        reservationId: reservation.id,
        lotId: input.lotId,
        lotAssumed: false,
        commandId: input.commandId,
        actorUserId: input.actorUserId ?? null,
      });
      return;
    }

    // Otherwise: one movement PER LOT drawn from, oldest first. An issue of 40 that
    // empties a 25-sheet lot and takes 15 from the next writes two rows, not one —
    // which is exactly what makes "which heats went into this unit" answerable, and
    // what a single aggregated row would destroy.
    //
    // Every one of these is marked ASSUMED. Nobody named these lots; the oldest-first
    // rule did. Recording them as confirmed is the precise lie `lotAssumed` exists to
    // prevent, and until the pick is scanned it is the honest answer.
    const draws = await allocateAcrossLots(tx, input.itemId, input.locationId, input.quantity);
    for (const draw of draws) {
      await tx.insert(inventoryMovements).values({
        itemId: input.itemId,
        locationId: input.locationId,
        type: "ISSUE",
        quantity: -draw.quantity,
        requirementId: input.requirementId,
        reservationId: reservation.id,
        lotId: draw.lotId,
        lotAssumed: draw.lotId !== null,
        commandId: input.commandId,
        actorUserId: input.actorUserId ?? null,
      });
    }
  });
}

/**
 * Ad-hoc issue with no reservation. Guard protects OTHER orders' reservations:
 * only unreserved stock may be taken this way.
 */
export async function issueUnreserved(
  input: {
    commandId: string;
    requirementId: number;
    itemId: number;
    locationId: number;
    quantity: number;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "IssueUnreserved", input)) === "replay") return;

    const balance = await lockBalance(tx, input.itemId, input.locationId);
    const free = balance.onHand - balance.activeReserved - balance.heldQty;

    if (free < input.quantity) {
      throw new CommandError(
        `Only ${free} usable of ${balance.onHand} on hand; ${balance.activeReserved} reserved to other work, ${balance.heldQty} on hold`,
        balance.heldQty > 0 && balance.onHand - balance.activeReserved >= input.quantity
          ? "ON_HOLD"
          : "INSUFFICIENT_STOCK"
      );
    }

    await tx
      .update(inventoryBalances)
      .set({ onHand: balance.onHand - input.quantity })
      .where(eq(inventoryBalances.id, balance.id));

    const [req] = await tx
      .select()
      .from(materialRequirements)
      .where(eq(materialRequirements.id, input.requirementId));
    await tx
      .update(materialRequirements)
      .set({ issuedQty: req.issuedQty + input.quantity })
      .where(eq(materialRequirements.id, input.requirementId));

    // Same lot split as the reserved path. An unreserved issue is still material
    // leaving the building and still has to be traceable.
    const draws = await allocateAcrossLots(tx, input.itemId, input.locationId, input.quantity);
    for (const draw of draws) {
      await tx.insert(inventoryMovements).values({
        itemId: input.itemId,
        locationId: input.locationId,
        type: "ISSUE",
        quantity: -draw.quantity,
        requirementId: input.requirementId,
        lotId: draw.lotId,
        commandId: input.commandId,
        actorUserId: input.actorUserId ?? null,
      });
    }
  });
}

/** Return unused material to stores. Raises the requirement's uncovered quantity again. */
export async function returnMaterial(
  input: {
    commandId: string;
    requirementId: number;
    itemId: number;
    locationId: number;
    quantity: number;
  },
  exec: Exec = {}
): Promise<void> {
  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReturnMaterial", input)) === "replay") return;

    const balance = await lockBalance(tx, input.itemId, input.locationId);
    await tx
      .update(inventoryBalances)
      .set({ onHand: balance.onHand + input.quantity })
      .where(eq(inventoryBalances.id, balance.id));

    const [req] = await tx
      .select()
      .from(materialRequirements)
      .where(eq(materialRequirements.id, input.requirementId));
    await tx
      .update(materialRequirements)
      .set({ returnedQty: req.returnedQty + input.quantity })
      .where(eq(materialRequirements.id, input.requirementId));

    // A return goes back to the lots it came OUT of, not to whatever is oldest.
    // We know which those are: they are the issue movements against this same
    // requirement. Crediting them back is what stops a return from inventing stock
    // of a heat that was never drawn — which would corrupt the trace in the one
    // direction nobody would think to check.
    const draws = await returnToIssuedLots(
      tx,
      input.requirementId,
      input.itemId,
      input.locationId,
      input.quantity
    );
    for (const draw of draws) {
      await tx.insert(inventoryMovements).values({
        itemId: input.itemId,
        locationId: input.locationId,
        type: "RETURN",
        quantity: draw.quantity,
        requirementId: input.requirementId,
        lotId: draw.lotId,
        commandId: input.commandId,
      });
    }
  });
}

/**
 * Split a return across the lots this requirement actually drew from, most recently
 * issued first, never crediting a lot more than it was issued net of earlier returns.
 *
 * Anything beyond what was issued — which should not happen, and the caller's guard
 * stops it — comes back unlotted rather than being attributed to a lot at random.
 */
async function returnToIssuedLots(
  tx: Tx,
  requirementId: number,
  itemId: number,
  locationId: number,
  quantity: number
): Promise<{ lotId: number | null; quantity: number }[]> {
  const rows = await tx
    .select({
      lotId: inventoryMovements.lotId,
      // Issues are negative and returns positive, so the negated sum is what is still
      // out against this lot.
      outstanding: sql<number>`coalesce(-sum(${inventoryMovements.quantity}), 0)::int`,
      /*
        Ordered by the movement id, NOT by created_at.

        Both lots of one issue are written inside a single transaction, so
        `now()` returns the identical timestamp for each and "most recent" becomes
        a coin toss — a test that passed on one run failed on the next. The serial
        id is monotonic in insertion order and has no ties, which is the property
        this actually needs.
      */
      lastSeq: sql<number>`max(${inventoryMovements.id})`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.requirementId, requirementId),
        eq(inventoryMovements.itemId, itemId),
        eq(inventoryMovements.locationId, locationId),
        inArray(inventoryMovements.type, ["ISSUE", "RETURN"])
      )
    )
    .groupBy(inventoryMovements.lotId);

  const ordered = rows
    .filter((r) => r.outstanding > 0)
    .sort((a, b) => b.lastSeq - a.lastSeq);

  const draws: { lotId: number | null; quantity: number }[] = [];
  let left = quantity;
  for (const row of ordered) {
    if (left === 0) break;
    const take = Math.min(left, row.outstanding);
    if (take === 0) continue;
    draws.push({ lotId: row.lotId, quantity: take });
    left -= take;
  }
  if (left > 0) draws.push({ lotId: null, quantity: left });
  return draws;
}

export type Discrepancy = {
  itemId: number;
  locationId: number;
  field: "onHand" | "activeReserved" | "heldQty";
  balance: number;
  history: number;
};

/**
 * Reconciliation (§5). Each current-state field reconciles against ITS OWN history:
 *   onHand         <- sum of inventory movements
 *   activeReserved <- sum of outstanding reservations
 *   heldQty        <- sum of open (unreleased) holds
 *
 * Reservations and holds are commitments, not stock movements, so checking them against
 * the movement ledger would always disagree.
 */
export async function reconcile(exec: Exec = {}): Promise<Discrepancy[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const rows = await database
    .select({
      itemId: inventoryBalances.itemId,
      locationId: inventoryBalances.locationId,
      onHand: inventoryBalances.onHand,
      activeReserved: inventoryBalances.activeReserved,
      heldQty: inventoryBalances.heldQty,
      movementSum: sql<number>`coalesce((
        select sum(m.quantity) from inventory_movements m
        where m.item_id = ${inventoryBalances.itemId}
          and m.location_id = ${inventoryBalances.locationId}
      ), 0)::int`,
      reservationSum: sql<number>`coalesce((
        select sum(r.outstanding_qty) from reservations r
        where r.item_id = ${inventoryBalances.itemId}
          and r.location_id = ${inventoryBalances.locationId}
      ), 0)::int`,
      holdSum: sql<number>`coalesce((
        select sum(h.quantity) from inventory_holds h
        where h.item_id = ${inventoryBalances.itemId}
          and h.location_id = ${inventoryBalances.locationId}
          and h.released_at is null
      ), 0)::int`,
    })
    .from(inventoryBalances);

  const out: Discrepancy[] = [];
  for (const r of rows) {
    const base = { itemId: r.itemId, locationId: r.locationId };
    if (r.onHand !== r.movementSum)
      out.push({ ...base, field: "onHand", balance: r.onHand, history: r.movementSum });
    if (r.activeReserved !== r.reservationSum)
      out.push({
        ...base,
        field: "activeReserved",
        balance: r.activeReserved,
        history: r.reservationSum,
      });
    if (r.heldQty !== r.holdSum)
      out.push({ ...base, field: "heldQty", balance: r.heldQty, history: r.holdSum });
  }
  return out;
}

/** Place stock on quality hold. Held stock is unavailable to reserve or issue. */
export async function placeHold(
  input: {
    commandId: string;
    itemId: number;
    locationId: number;
    quantity: number;
    reason: string;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<{ holdId: number }> {
  let holdId = 0;
  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "PlaceHold", input)) === "replay") return;

    const balance = await lockBalance(tx, input.itemId, input.locationId);

    // A hold may cover reserved stock — quality does not defer to commitments.
    const holdable = balance.onHand - balance.heldQty;
    if (holdable < input.quantity) {
      throw new CommandError(
        `Only ${holdable} can be held; ${balance.heldQty} of ${balance.onHand} is already on hold`,
        "INSUFFICIENT_STOCK"
      );
    }

    const newHeld = balance.heldQty + input.quantity;

    /*
     * A reservation standing against held stock can no longer be honoured, so it is
     * released here, in this transaction. Leaving it would let an earlier reservation
     * nominally authorise a reserved issue of the held component, with correctness
     * resting entirely on the secondary onHand - heldQty guard.
     *
     * Newest first, preserving the seniority the reservation system already grants
     * (first to reserve wins). Releasing a hold does not re-create these — the material
     * must be re-reserved, since priorities may have moved on.
     */
    let excess = balance.activeReserved + newHeld - balance.onHand;
    let releasedTotal = 0;

    if (excess > 0) {
      const standing = await tx
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.itemId, input.itemId),
            eq(reservations.locationId, input.locationId)
          )
        )
        .orderBy(desc(reservations.id))
        .for("update");

      for (const r of standing) {
        if (excess <= 0) break;
        const take = Math.min(r.outstandingQty, excess);
        if (take <= 0) continue;

        await tx
          .update(reservations)
          .set({ outstandingQty: r.outstandingQty - take })
          .where(eq(reservations.id, r.id));

        await tx.insert(inventoryMovements).values({
          itemId: input.itemId,
          locationId: input.locationId,
          type: "ADJUSTMENT",
          quantity: 0,
          requirementId: r.requirementId,
          reservationId: r.id,
          commandId: input.commandId,
          actorUserId: input.actorUserId ?? null,
        });

        excess -= take;
        releasedTotal += take;
      }

      if (excess > 0) {
        throw new CommandError(
          "Cannot hold that quantity: reservations could not be released to make room",
          "INSUFFICIENT_STOCK"
        );
      }
    }

    await tx
      .update(inventoryBalances)
      .set({
        heldQty: newHeld,
        activeReserved: balance.activeReserved - releasedTotal,
      })
      .where(eq(inventoryBalances.id, balance.id));

    const [hold] = await tx
      .insert(inventoryHolds)
      .values({
        itemId: input.itemId,
        locationId: input.locationId,
        quantity: input.quantity,
        reason: input.reason,
        raisedByUserId: input.actorUserId ?? null,
      })
      .returning();
    holdId = hold.id;
  });
  return { holdId };
}

/** Release a hold. Idempotent: an already-released hold restores availability once only. */
export async function releaseHold(
  input: { commandId: string; holdId: number; actorUserId?: number },
  exec: Exec = {}
): Promise<void> {
  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReleaseHold", input)) === "replay") return;

    const [hold] = await tx
      .select()
      .from(inventoryHolds)
      .where(eq(inventoryHolds.id, input.holdId))
      .for("update");
    if (!hold) throw new CommandError("Hold not found", "NOT_FOUND");

    // Guard, independent of command identity: a released hold cannot be released again.
    if (hold.releasedAt !== null) {
      throw new CommandError("That hold is already released", "STATE_GUARD");
    }

    const balance = await lockBalance(tx, hold.itemId, hold.locationId);
    await tx
      .update(inventoryBalances)
      .set({ heldQty: balance.heldQty - hold.quantity })
      .where(eq(inventoryBalances.id, balance.id));

    await tx
      .update(inventoryHolds)
      .set({ releasedAt: new Date(), releasedByUserId: input.actorUserId ?? null })
      .where(eq(inventoryHolds.id, hold.id));
  });
}

/**
 * Write stock off as damaged.
 *
 * The handler walks to the rack, scans the pallet, and finds it bent, wet or
 * short. Until now there was nowhere to say so: SCRAP existed as a movement type
 * and nothing in the system ever wrote one against stock, so damage was recorded
 * by quietly adjusting a number, or not at all.
 *
 * Two decisions worth knowing about.
 *
 * DAMAGE DOES NOT DEFER TO COMMITMENTS. A reserved pallet that has been dropped is
 * still a dropped pallet. Reservations that can no longer be honoured are released
 * here, in this transaction, newest first — the same seniority rule `placeHold`
 * uses. The alternative is refusing to record what happened because of a claim on
 * material that no longer exists, which is how a system teaches people to lie to it.
 *
 * THE LOT IS NAMED, NEVER INFERRED. This is reached by scanning a specific batch,
 * so `lotAssumed` is false: the trace can say which heat was thrown away, and mean it.
 */
export async function scrapStock(
  input: {
    commandId: string;
    itemId: number;
    locationId: number;
    quantity: number;
    /** The scanned batch. Null only for stock that predates lot tracking. */
    lotId?: number | null;
    reason: string;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<{ scrapped: number; reservationsReleased: number }> {
  let scrapped = 0;
  let reservationsReleased = 0;

  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ScrapStock", input)) === "replay") return;
    if (input.quantity < 1) {
      throw new CommandError("Quantity must be at least 1", "STATE_GUARD");
    }
    if (!input.reason.trim()) {
      throw new CommandError("Say why it is being written off", "STATE_GUARD");
    }

    const balance = await lockBalance(tx, input.itemId, input.locationId);
    if (balance.onHand < input.quantity) {
      throw new CommandError(
        `Only ${balance.onHand} on hand at this location`,
        "INSUFFICIENT_STOCK"
      );
    }

    // A named batch cannot give up more than it still holds, however much of the
    // item sits at this location in other batches.
    if (input.lotId) {
      const [lot] = await tx
        .select({
          remaining: sql<number>`coalesce(sum(${inventoryMovements.quantity}), 0)::int`,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.lotId, input.lotId),
            eq(inventoryMovements.locationId, input.locationId)
          )
        );
      const remaining = lot?.remaining ?? 0;
      if (remaining < input.quantity) {
        throw new CommandError(
          `That batch has only ${remaining} left`,
          "INSUFFICIENT_STOCK"
        );
      }
    }

    const newOnHand = balance.onHand - input.quantity;

    let excess = balance.activeReserved + balance.heldQty - newOnHand;
    let released = 0;
    if (excess > 0) {
      const standing = await tx
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.itemId, input.itemId),
            eq(reservations.locationId, input.locationId)
          )
        )
        .orderBy(desc(reservations.id))
        .for("update");

      for (const r of standing) {
        if (excess <= 0) break;
        const take = Math.min(r.outstandingQty, excess);
        if (take <= 0) continue;
        await tx
          .update(reservations)
          .set({ outstandingQty: r.outstandingQty - take })
          .where(eq(reservations.id, r.id));
        excess -= take;
        released += take;
      }

      // Held stock cannot be released by this command — a quality hold is somebody
      // else's decision, and writing the units off underneath it would erase it.
      if (excess > 0) {
        throw new CommandError(
          `Cannot write that off: ${balance.heldQty} is on quality hold. Release the hold first`,
          "INSUFFICIENT_STOCK"
        );
      }
    }

    await tx
      .update(inventoryBalances)
      .set({ onHand: newOnHand, activeReserved: balance.activeReserved - released })
      .where(
        and(
          eq(inventoryBalances.itemId, input.itemId),
          eq(inventoryBalances.locationId, input.locationId)
        )
      );

    await tx.insert(inventoryMovements).values({
      itemId: input.itemId,
      locationId: input.locationId,
      type: "SCRAP",
      quantity: -input.quantity,
      lotId: input.lotId ?? null,
      lotAssumed: false,
      note: input.reason.trim(),
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });

    scrapped = input.quantity;
    reservationsReleased = released;
  });

  return { scrapped, reservationsReleased };
}
