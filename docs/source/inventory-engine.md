# Source: src/lib/inventory.ts

Commit 32fe146. Reproduced as a document because the source archive has not been reaching the reviewer.

```ts
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
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
      | "COMMAND_ID_REUSED"
      | "STATE_GUARD"
      | "NOT_FOUND"
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

/** Bring stock in. */
export async function receiveStock(
  input: { commandId: string; itemId: number; locationId: number; quantity: number; actorUserId?: number },
  exec: Exec = {}
): Promise<void> {
  await run(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReceiveStock", input)) === "replay") return;

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
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
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

    await tx.insert(inventoryMovements).values({
      itemId: input.itemId,
      locationId: input.locationId,
      type: "ISSUE",
      quantity: -input.quantity,
      requirementId: input.requirementId,
      reservationId: reservation.id,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
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

    await tx.insert(inventoryMovements).values({
      itemId: input.itemId,
      locationId: input.locationId,
      type: "ISSUE",
      quantity: -input.quantity,
      requirementId: input.requirementId,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
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

    await tx.insert(inventoryMovements).values({
      itemId: input.itemId,
      locationId: input.locationId,
      type: "RETURN",
      quantity: input.quantity,
      requirementId: input.requirementId,
      commandId: input.commandId,
    });
  });
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
```
