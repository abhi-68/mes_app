"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { materialRequirements } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { canWorkOnTask, terminalStation } from "@/lib/terminal";
import {
  CommandError, issueAgainstReservation, issueUnreserved, reserveForRequirement, coverageFor,
  scrapIssuedMaterial,
} from "@/lib/inventory";
import { pickingLocation } from "@/lib/material-planning";
import {
  findPickLot, operationForPick, pickListFor, type PickLine,
} from "@/lib/picking";

export type { PickLine };

const request = z
  .object({
    commandId: z.uuid(),
    operationId: z.number().int().positive(),
    requirementId: z.number().int().positive(),
    batchNumber: z.string().trim().min(1).max(64),
    quantity: z.number().int().positive(),
  })
  .strict();

export type PickResult = {
  taken: number;
  outstanding: number;
  batchNumber: string;
  itemName: string;
};

/**
 * Take material against a step by scanning the batch in your hands.
 *
 * This is the moment stock actually leaves the shelf. Start commits it; this moves
 * it, from the batch the handler scanned rather than the one the system would have
 * guessed, so the movement is recorded as confirmed rather than assumed.
 */
export async function pickMaterial(
  input: z.infer<typeof request>
): Promise<{ ok: true; result: PickResult } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const parsed = request.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Scan a batch and say how many" };
    const { commandId, operationId, requirementId, batchNumber, quantity } = parsed.data;

    const task = await operationForPick(operationId);
    if (!task) return { ok: false, error: "That step does not exist" };
    if (task.status === "DONE") {
      return { ok: false, error: "That step is already finished" };
    }

    // The same rule that guards Start: you draw material for the station you are at.
    const terminal = await terminalStation();
    const permission = canWorkOnTask({
      role: user.role,
      userId: user.id,
      homeStationId: user.stationId,
      terminalStationId: terminal?.id ?? null,
      taskStationId: task.stationId,
      assignedToUserId: task.assignedToUserId,
    });
    if (!permission.allowed) return { ok: false, error: permission.reason };

    const [req] = await db
      .select()
      .from(materialRequirements)
      .where(eq(materialRequirements.id, requirementId));
    if (!req || req.operationId !== operationId) {
      return { ok: false, error: "That material is not for this step" };
    }

    const location = await pickingLocation();
    if (!location) return { ok: false, error: "No stock location is configured" };
    const locationId = location.id;

    const lot = await findPickLot(batchNumber, locationId);
    if (!lot) return { ok: false, error: `No batch is labelled ${batchNumber}` };

    // Holding the wrong pallet is the common mistake, so it gets its own sentence.
    if (lot.itemId !== req.itemId) {
      return {
        ok: false,
        error: `${lot.batchNumber} is ${lot.itemName}. This step needs a different part.`,
      };
    }
    if (lot.remaining < quantity) {
      return { ok: false, error: `That batch has only ${lot.remaining} left` };
    }

    const before = await coverageFor(requirementId);
    const outstandingBefore = Math.max(0, req.requiredQty - before.netIssued);
    if (outstandingBefore <= 0) {
      return { ok: false, error: "This step already has everything it needs" };
    }
    if (quantity > outstandingBefore) {
      return { ok: false, error: `This step needs only ${outstandingBefore} more` };
    }

    await db.transaction(async (tx) => {
      // Start reserves, but a step can be picked against without having been
      // started, and stock can be written off underneath a reservation. Top the
      // commitment up to cover this pick rather than refusing it.
      const cover = await coverageFor(requirementId, { tx });
      if (cover.activeReserved < quantity) {
        await reserveForRequirement(
          {
            commandId: `${commandId}:reserve`,
            requirementId,
            itemId: req.itemId,
            locationId,
            quantity: quantity - cover.activeReserved,
          },
          { tx }
        );
      }

      await issueAgainstReservation(
        {
          commandId,
          requirementId,
          itemId: req.itemId,
          locationId,
          quantity,
          lotId: lot.lotId,
          actorUserId: user.id,
        },
        { tx }
      );
    });

    const lines = await pickListFor(operationId);
    const line = lines.find((l) => l.requirementId === requirementId);

    revalidatePath("/", "layout");
    return {
      ok: true,
      result: {
        taken: quantity,
        outstanding: line?.outstanding ?? 0,
        batchNumber: lot.batchNumber,
        itemName: lot.itemName,
      },
    };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not take that material. Retry — it will not take twice." };
  }
}

const unlabelledRequest = z
  .object({
    commandId: z.uuid(),
    operationId: z.number().int().positive(),
    requirementId: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })
  .strict();

/**
 * Take material off a pallet that has no label on it.
 *
 * Opening balances, stock counts and anything booked in before labelling started
 * have no batch behind them. Without this the scan is the only way to account for
 * material, and a step whose stock predates labelling could never be started at
 * all. The movement records ASSUMED lots, so the trace says "nobody named this"
 * rather than naming a pallet nobody looked at.
 */
export async function pickUnlabelled(
  input: z.infer<typeof unlabelledRequest>
): Promise<{ ok: true; result: PickResult } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const parsed = unlabelledRequest.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Say how many you took" };
    const { commandId, operationId, requirementId, quantity } = parsed.data;

    const task = await operationForPick(operationId);
    if (!task) return { ok: false, error: "That step does not exist" };
    if (task.status === "DONE") return { ok: false, error: "That step is already finished" };

    const terminal = await terminalStation();
    const permission = canWorkOnTask({
      role: user.role,
      userId: user.id,
      homeStationId: user.stationId,
      terminalStationId: terminal?.id ?? null,
      taskStationId: task.stationId,
      assignedToUserId: task.assignedToUserId,
    });
    if (!permission.allowed) return { ok: false, error: permission.reason };

    const [req] = await db
      .select()
      .from(materialRequirements)
      .where(eq(materialRequirements.id, requirementId));
    if (!req || req.operationId !== operationId) {
      return { ok: false, error: "That material is not for this step" };
    }

    const location = await pickingLocation();
    if (!location) return { ok: false, error: "No stock location is configured" };

    const before = await coverageFor(requirementId);
    const outstandingBefore = Math.max(0, req.requiredQty - before.netIssued);
    if (outstandingBefore <= 0) {
      return { ok: false, error: "This step already has everything it needs" };
    }
    if (quantity > outstandingBefore) {
      return { ok: false, error: `This step needs only ${outstandingBefore} more` };
    }

    await issueUnreserved({
      commandId,
      requirementId,
      itemId: req.itemId,
      locationId: location.id,
      quantity,
      actorUserId: user.id,
    });

    const line = (await pickListFor(operationId)).find((l) => l.requirementId === requirementId);

    revalidatePath("/", "layout");
    return {
      ok: true,
      result: {
        taken: quantity,
        outstanding: line?.outstanding ?? 0,
        batchNumber: "no label",
        itemName: line?.itemName ?? "",
      },
    };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not take that material. Retry — it will not take twice." };
  }
}

const scrapRequest = z  .object({
    commandId: z.uuid(),
    operationId: z.number().int().positive(),
    requirementId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    reasonCodeId: z.number().int().positive().nullable(),
    /** The label on the thing being thrown away. Null = the operator could not scan it. */
    batchNumber: z.string().trim().min(1).max(64).nullable(),
    note: z.string().trim().max(500).nullable(),
  })
  .strict();

/**
 * The operator opens the box and the material is no good.
 *
 * Recorded at the bench, by the person holding it. The batch is SCANNED, not
 * inferred: picking oldest-first is a fair guess about which pallet was taken and
 * a poor fact about which one was bad, and a guess recorded as a fact is exactly
 * what makes a trace worth less than no trace. Unscanned writes off with no lot,
 * which reads as "not known" and is the truth.
 *
 * The step goes short again on its own — readiness already subtracts WIP scrap —
 * so nobody has to remember to re-block it.
 */
export async function scrapMaterialAtStep(
  input: z.infer<typeof scrapRequest>
): Promise<{ ok: true; result: { scrapped: number; stillIssued: number } } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const parsed = scrapRequest.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Say how many and why" };
    const { commandId, operationId, requirementId, quantity, reasonCodeId, batchNumber, note } =
      parsed.data;

    const task = await operationForPick(operationId);
    if (!task) return { ok: false, error: "That step does not exist" };
    if (task.status === "DONE") return { ok: false, error: "That step is already finished" };

    const terminal = await terminalStation();
    const permission = canWorkOnTask({
      role: user.role,
      userId: user.id,
      homeStationId: user.stationId,
      terminalStationId: terminal?.id ?? null,
      taskStationId: task.stationId,
      assignedToUserId: task.assignedToUserId,
    });
    if (!permission.allowed) return { ok: false, error: permission.reason };

    const [req] = await db
      .select()
      .from(materialRequirements)
      .where(eq(materialRequirements.id, requirementId));
    if (!req || req.operationId !== operationId) {
      return { ok: false, error: "That material is not for this step" };
    }
    if (!reasonCodeId) return { ok: false, error: "Pick a reason" };

    let lotId: number | null = null;
    if (batchNumber) {
      const location = await pickingLocation();
      if (!location) return { ok: false, error: "No stock location is configured" };
      const lot = await findPickLot(batchNumber, location.id);
      if (!lot) return { ok: false, error: `No batch is labelled ${batchNumber}` };
      // Refusing by name beats refusing by code: the operator is holding a label.
      if (lot.itemId !== req.itemId) {
        return {
          ok: false,
          error: `${lot.batchNumber} is ${lot.itemName}. This step does not use that.`,
        };
      }
      lotId = lot.lotId;
    }

    const result = await scrapIssuedMaterial({
      commandId,
      requirementId,
      quantity,
      lotId,
      reasonCodeId,
      note,
      actorUserId: user.id,
    });

    revalidatePath("/", "layout");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not record that. Retry — it will not record twice." };
  }
}
