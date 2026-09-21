import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb } from "@/db";
import * as schema from "@/db/schema";
import { operationOutputs, dispositionRecords } from "@/db/schema";
import { CommandError, type Exec } from "@/lib/inventory";
import { createHash } from "node:crypto";
import { processedCommands } from "@/db/schema";

/**
 * Operation output engine — IMPL-SPEC rev 4 §1 Axis B.
 *
 * The rule that shapes this whole file: CURRENT availability is never derived from a
 * monotonically increasing counter. `operation_outputs` holds mutable current state;
 * `disposition_records` holds the append-only history beside it. That is the same
 * separation used for inventory balances versus movements.
 *
 * Two cases a monotonic model gets wrong, and which are tested:
 *   issue -> return -> reissue      (a return must restore usable output)
 *   accept -> rework -> re-accept   (must not invent a second physical unit)
 */

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function runIn<T>(exec: Exec, body: (tx: Tx) => Promise<T>): Promise<T> {
  if (exec.tx) return body(exec.tx as Tx);
  return (exec.db ?? defaultDb).transaction(body);
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 64);
}

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

async function lockOutput(tx: Tx, operationId: number) {
  const existing = await tx
    .select()
    .from(operationOutputs)
    .where(eq(operationOutputs.operationId, operationId))
    .for("update");
  if (existing.length > 0) return existing[0];

  await tx.insert(operationOutputs).values({ operationId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(operationOutputs)
    .where(eq(operationOutputs.operationId, operationId))
    .for("update");
  return row;
}

export type OutputState = {
  produced: number;
  pendingInspection: number;
  accepted: number;
  awaitingRework: number;
  scrapped: number;
  allocatedOutstanding: number;
  issuedToParentOutstanding: number;
  heldQty: number;
  /** accepted − allocatedOutstanding − issuedToParentOutstanding − heldQty */
  usableOutput: number;
};

export async function outputStateFor(
  operationId: number,
  exec: Exec = {}
): Promise<OutputState> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(operationOutputs)
    .where(eq(operationOutputs.operationId, operationId));

  const base = row ?? {
    produced: 0,
    pendingInspection: 0,
    accepted: 0,
    awaitingRework: 0,
    scrapped: 0,
    allocatedOutstanding: 0,
    issuedToParentOutstanding: 0,
    heldQty: 0,
  };

  return {
    produced: base.produced,
    pendingInspection: base.pendingInspection,
    accepted: base.accepted,
    awaitingRework: base.awaitingRework,
    scrapped: base.scrapped,
    allocatedOutstanding: base.allocatedOutstanding,
    issuedToParentOutstanding: base.issuedToParentOutstanding,
    heldQty: base.heldQty,
    usableOutput:
      base.accepted -
      base.allocatedOutstanding -
      base.issuedToParentOutstanding -
      base.heldQty,
  };
}

/** New output arrives as pendingInspection — never as accepted, never as scrap. */
export async function reportProduction(
  input: { commandId: string; operationId: number; quantity: number; actorUserId?: number },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReportProduction", input)) === "replay") return;
    if (input.quantity < 1) throw new CommandError("Quantity must be at least 1", "STATE_GUARD");

    const out = await lockOutput(tx, input.operationId);
    await tx
      .update(operationOutputs)
      .set({
        produced: out.produced + input.quantity,
        pendingInspection: out.pendingInspection + input.quantity,
      })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "PRODUCED",
      quantity: input.quantity,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/**
 * Inspect output. Moves quantity between dispositions on the SAME physical units —
 * `produced` never changes, so re-accepting a repaired unit cannot invent a new one.
 */
export async function inspectOutput(
  input: {
    commandId: string;
    operationId: number;
    from: "pendingInspection" | "awaitingRework" | "accepted";
    to: "accepted" | "awaitingRework" | "scrapped";
    quantity: number;
    reason?: string;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "InspectOutput", input)) === "replay") return;
    if (input.from === input.to) throw new CommandError("Nothing to move", "STATE_GUARD");

    const out = await lockOutput(tx, input.operationId);
    const available = out[input.from];
    if (available < input.quantity) {
      throw new CommandError(
        `Only ${available} in ${input.from}, cannot move ${input.quantity}`,
        "STATE_GUARD"
      );
    }

    // Moving OUT of accepted may only touch uncommitted quantity — anything allocated
    // or already installed in a parent is handled by rejectInstalled instead (§5).
    if (input.from === "accepted") {
      const uncommitted =
        out.accepted - out.allocatedOutstanding - out.issuedToParentOutstanding;
      if (uncommitted < input.quantity) {
        throw new CommandError(
          `Only ${uncommitted} accepted units are uncommitted; the rest is allocated or installed`,
          "STATE_GUARD"
        );
      }
    }

    await tx
      .update(operationOutputs)
      .set({
        [input.from]: out[input.from] - input.quantity,
        [input.to]: out[input.to] + input.quantity,
      })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: input.to === "accepted" ? "ACCEPT" : input.to === "awaitingRework" ? "REWORK" : "SCRAP",
      quantity: input.quantity,
      reason: input.reason ?? null,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/** Earmark accepted output for one material requirement. */
export async function allocateOutput(
  input: {
    commandId: string;
    operationId: number;
    requirementId: number;
    quantity: number;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "AllocateOutput", input)) === "replay") return;

    const out = await lockOutput(tx, input.operationId);
    const usable =
      out.accepted - out.allocatedOutstanding - out.issuedToParentOutstanding - out.heldQty;
    if (usable < input.quantity) {
      throw new CommandError(
        `Only ${usable} usable accepted units available to allocate`,
        "STATE_GUARD"
      );
    }

    await tx
      .update(operationOutputs)
      .set({ allocatedOutstanding: out.allocatedOutstanding + input.quantity })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "ALLOCATE",
      quantity: input.quantity,
      requirementId: input.requirementId,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/** Install allocated output into its parent. Relieves the allocation. */
export async function issueOutputToParent(
  input: {
    commandId: string;
    operationId: number;
    requirementId: number;
    quantity: number;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "IssueOutputToParent", input)) === "replay")
      return;

    const out = await lockOutput(tx, input.operationId);
    if (out.allocatedOutstanding < input.quantity) {
      throw new CommandError(
        `Only ${out.allocatedOutstanding} allocated, cannot install ${input.quantity}`,
        "STATE_GUARD"
      );
    }

    await tx
      .update(operationOutputs)
      .set({
        allocatedOutstanding: out.allocatedOutstanding - input.quantity,
        issuedToParentOutstanding: out.issuedToParentOutstanding + input.quantity,
      })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "ISSUE_TO_PARENT",
      quantity: input.quantity,
      requirementId: input.requirementId,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/**
 * Take an uninstalled component back out of a parent. This is a PHYSICAL movement and it
 * restores usable output — unlike a rejection, which is a quality judgement that does not.
 * The original install record stays in history.
 */
export async function returnOutputFromParent(
  input: {
    commandId: string;
    operationId: number;
    requirementId: number;
    quantity: number;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReturnOutputFromParent", input)) === "replay")
      return;

    const out = await lockOutput(tx, input.operationId);
    if (out.issuedToParentOutstanding < input.quantity) {
      throw new CommandError(
        `Only ${out.issuedToParentOutstanding} are installed, cannot return ${input.quantity}`,
        "STATE_GUARD"
      );
    }

    await tx
      .update(operationOutputs)
      .set({ issuedToParentOutstanding: out.issuedToParentOutstanding - input.quantity })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "RETURN_FROM_PARENT",
      quantity: input.quantity,
      requirementId: input.requirementId,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/**
 * Reject output that is ALREADY INSTALLED in a parent (spec §5).
 *
 * Deliberately does not touch the producing operation's disposition: the component was
 * installed, and that remains true. It appends a rejection record; holding the parent is
 * the caller's responsibility and is recorded against the parent, not here.
 */
export async function rejectInstalledOutput(
  input: {
    commandId: string;
    operationId: number;
    requirementId: number;
    quantity: number;
    reason: string;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "RejectInstalledOutput", input)) === "replay")
      return;

    const out = await lockOutput(tx, input.operationId);
    if (out.issuedToParentOutstanding < input.quantity) {
      throw new CommandError(
        `Only ${out.issuedToParentOutstanding} are installed, cannot reject ${input.quantity}`,
        "STATE_GUARD"
      );
    }

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "REJECT_INSTALLED",
      quantity: input.quantity,
      requirementId: input.requirementId,
      reason: input.reason,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/**
 * Dependency satisfaction for REQUIRED_QUANTITY (spec §2): outstanding allocation PLUS
 * what has already been installed against this requirement. Reading only the outstanding
 * allocation would make an operation unable to resume after consuming its parts.
 */
export async function satisfiedQuantityFor(
  requirementId: number,
  exec: Exec = {}
): Promise<number> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const rows = await database
    .select()
    .from(dispositionRecords)
    .where(eq(dispositionRecords.requirementId, requirementId));

  let allocated = 0;
  let installed = 0;
  for (const r of rows) {
    if (r.kind === "ALLOCATE") allocated += r.quantity;
    if (r.kind === "DEALLOCATE") allocated -= r.quantity;
    if (r.kind === "ISSUE_TO_PARENT") {
      allocated -= r.quantity;
      installed += r.quantity;
    }
    if (r.kind === "RETURN_FROM_PARENT") installed -= r.quantity;
  }
  return Math.max(0, allocated) + Math.max(0, installed);
}

/**
 * Quarantine finished output at the operation that made it.
 *
 * Distinct from an inventory hold: that quarantines stock in a location, this
 * quarantines a sub-assembly's own output before it is handed to a parent. It is
 * what a QUALITY_ACCEPTANCE dependency reads — a parent step must not proceed on
 * units that are under question, even when the quantity exists.
 *
 * Held units stay `accepted`; they are simply not usable, exactly as with
 * inventory. Deriving "accepted minus held" rather than moving the quantity keeps
 * the release path from having to guess where to move it back to.
 */
export async function holdOutput(
  input: {
    commandId: string;
    operationId: number;
    quantity: number;
    reason: string;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "HoldOutput", input)) === "replay") return;
    if (input.quantity <= 0) throw new CommandError("Quantity must be positive", "STATE_GUARD");

    const out = await lockOutput(tx, input.operationId);
    const usable =
      out.accepted - out.allocatedOutstanding - out.issuedToParentOutstanding - out.heldQty;
    if (usable < input.quantity) {
      throw new CommandError(
        `Only ${usable} usable accepted units available to hold`,
        "STATE_GUARD"
      );
    }

    await tx
      .update(operationOutputs)
      .set({ heldQty: out.heldQty + input.quantity })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "HOLD",
      quantity: input.quantity,
      reason: input.reason,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/** Release a quarantine. Idempotent per command, like every other command here. */
export async function releaseOutputHold(
  input: {
    commandId: string;
    operationId: number;
    quantity: number;
    reason?: string;
    actorUserId?: number;
  },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    if ((await claimCommand(tx, input.commandId, "ReleaseOutputHold", input)) === "replay") return;

    const out = await lockOutput(tx, input.operationId);
    if (out.heldQty < input.quantity) {
      throw new CommandError(
        `Only ${out.heldQty} units are held, cannot release ${input.quantity}`,
        "STATE_GUARD"
      );
    }

    await tx
      .update(operationOutputs)
      .set({ heldQty: out.heldQty - input.quantity })
      .where(eq(operationOutputs.id, out.id));

    await tx.insert(dispositionRecords).values({
      operationId: input.operationId,
      kind: "RELEASE_HOLD",
      quantity: input.quantity,
      reason: input.reason ?? null,
      commandId: input.commandId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

/**
 * Hand a finished sub-assembly to the parent order that is waiting for it.
 *
 * Without this the chain deadlocks. A REQUIRED_QUANTITY dependency is satisfied by
 * allocation against a material requirement, not by the child operation merely
 * being marked done — so finishing the fan section would leave final assembly
 * waiting forever, because nothing in the application can allocate.
 *
 * NOTE ON INSPECTION. Output is supposed to arrive as `pendingInspection` and
 * reach `accepted` only when someone inspects it (spec §1). There is no
 * inspection screen yet, so this accepts on completion and records that it did:
 * every disposition row carries the reason, and the history will show exactly
 * which units were never actually inspected. When the quality screens exist,
 * this shortcut goes and the inspector's decision takes its place.
 */
export async function deliverCompletedSubAssembly(
  input: { operationId: number; actorUserId?: number | null },
  exec: Exec = {}
): Promise<void> {
  await runIn(exec, async (tx) => {
    /**
     * Does what this operation makes have to be inspected before anyone may use it?
     *
     * `items.requiresInspection` existed, was documented, and was read by nothing,
     * so the auto-accept below ran for every part regardless. Completing a step and
     * accepting its output are two decisions by two people; collapsing them is how
     * uninspected work reaches final assembly.
     */
    const [gate] = await tx
      .select({ requiresInspection: schema.items.requiresInspection })
      .from(schema.workOrderTasks)
      .innerJoin(schema.workOrders, eq(schema.workOrderTasks.workOrderId, schema.workOrders.id))
      .innerJoin(schema.items, eq(schema.workOrders.itemId, schema.items.id))
      .where(eq(schema.workOrderTasks.id, input.operationId));
    const needsInspection = gate?.requiresInspection ?? false;

    const deps = await tx
      .select()
      .from(schema.operationDependencies)
      .where(
        and(
          eq(schema.operationDependencies.dependsOnOperationId, input.operationId),
          eq(schema.operationDependencies.type, "REQUIRED_QUANTITY")
        )
      );

    for (const dep of deps) {
      if (!dep.requirementId || !dep.requiredQuantity) continue;

      const already = await satisfiedQuantityFor(dep.requirementId, { tx });
      const need = dep.requiredQuantity - already;
      if (need <= 0) continue;

      const base = `deliver:${input.operationId}:${dep.id}`;

      await reportProduction(
        {
          commandId: `${base}:produce`,
          operationId: input.operationId,
          quantity: need,
          actorUserId: input.actorUserId ?? undefined,
        },
        { tx }
      );

      // Stop here when the part is inspected. The quantity stays as
      // pendingInspection: not accepted, not allocated, and the parent stays
      // blocked until a person passes it on /quality.
      if (needsInspection) continue;

      await inspectOutput(
        {
          commandId: `${base}:accept`,
          operationId: input.operationId,
          from: "pendingInspection",
          to: "accepted",
          quantity: need,
          reason: "Accepted on completion — this part has no inspection requirement",
          actorUserId: input.actorUserId ?? undefined,
        },
        { tx }
      );

      await allocateOutput(
        {
          commandId: `${base}:allocate`,
          operationId: input.operationId,
          requirementId: dep.requirementId,
          quantity: need,
          actorUserId: input.actorUserId ?? undefined,
        },
        { tx }
      );
    }
  });
}
