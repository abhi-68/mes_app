"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { eq, asc, max } from "drizzle-orm";
import { db } from "@/db";
import {
  items,
  routingSteps,
  bomLines,
  stations,
  users,
  reasonCodes,
  workOrders,
  inventoryLocations,
  customers,
  vendors,
} from "@/db/schema";
import { requireRole } from "@/lib/session";
import { nextWorkOrderNumber } from "@/lib/numbering";
import { releaseWorkOrder } from "@/lib/work-orders";
import { receiveStock } from "@/lib/inventory";
import { dueDateFromInput } from "@/lib/schedule";
import { randomUUID } from "node:crypto";

export type ActionResult = { ok: true } | { ok: false; error: string };

function wrap(fn: () => Promise<void>): Promise<ActionResult> {
  return fn()
    .then(() => {
      revalidatePath("/", "layout");
      return { ok: true } as const;
    })
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Something went wrong",
    }));
}

/**
 * wrap, for an action whose caller needs to know what it made.
 *
 * Raising an order is the case: the screen that asked for it wants to show the
 * order, and "it worked" is not enough to find it again.
 */
function wrapWith<T extends object>(
  fn: () => Promise<T>
): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  return fn()
    .then((value) => {
      revalidatePath("/", "layout");
      return { ok: true as const, ...value };
    })
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Something went wrong",
    }));
}

/* ------------------------------ Stations ------------------------------ */

export async function createStation(name: string, description: string): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (!name.trim()) throw new Error("A station needs a name");
    await db.insert(stations).values({ name: name.trim(), description: description.trim() || null });
  });
}

export async function setStationActive(id: number, active: boolean): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    await db.update(stations).set({ active }).where(eq(stations.id, id));
  });
}

/* -------------------------------- Items -------------------------------- */

export async function createItem(input: {
  sku: string;
  name: string;
  procurementType: "MANUFACTURED" | "PURCHASED";
  isFinishedGood: boolean;
  unitOfMeasure: string;
  openingStock: number;
  reorderPoint: number;
}): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (!input.sku.trim() || !input.name.trim()) throw new Error("SKU and name are both required");

    const [item] = await db
      .insert(items)
      .values({
        sku: input.sku.trim(),
        name: input.name.trim(),
        procurementType: input.procurementType,
        isFinishedGood: input.isFinishedGood,
        unitOfMeasure: input.unitOfMeasure.trim() || "ea",
        reorderPoint: Math.max(0, Math.floor(input.reorderPoint || 0)),
      })
      .returning();

    // Opening stock is a RECEIPT through the engine, so it lands in the movement
    // ledger and reconciles. There is deliberately no direct write path to balances.
    if (input.openingStock > 0) {
      const [loc] = await db.select().from(inventoryLocations).limit(1);
      if (!loc) throw new Error("Add a stock location before setting opening stock");
      await receiveStock({
        commandId: randomUUID(),
        itemId: item.id,
        locationId: loc.id,
        quantity: Math.max(0, input.openingStock),
      });
    }
  });
}

/* ------------------------------ Receiving ------------------------------ */

/**
 * Book a delivery in, as a lot.
 *
 * Supervisors as well as admins, because material arrives on a shift and waiting
 * for an admin is how a pallet sits in the bay unrecorded while a step upstairs
 * reports a shortage it does not have.
 */
export async function receiveDelivery(input: {
  itemId: number;
  locationId: number;
  quantity: number;
  heatNumber: string;
  batchNumber: string;
  vendorId: number | null;
  procurementReference: string;
  storageLocation: string;
}): Promise<ActionResult & { lotId?: number; batchNumber?: string }> {
  const user = await requireRole("SUPERVISOR", "ADMIN").catch(() => null);
  if (!user) return { ok: false, error: "This needs supervisor or admin access" };

  const quantity = Math.floor(input.quantity);
  if (!(quantity > 0)) return { ok: false, error: "Quantity has to be more than zero" };

  // A batch number is what goes on the label and what a scanner reads back, so one
  // is generated when nobody types one. A lot with no code is a lot nobody can find
  // on the rack.
  const batch =
    input.batchNumber.trim() ||
    `L${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

  try {
    const { lotId } = await receiveStock({
      commandId: randomUUID(),
      itemId: input.itemId,
      locationId: input.locationId,
      quantity,
      actorUserId: user.id,
      lot: {
        heatNumber: input.heatNumber,
        batchNumber: batch,
        vendorId: input.vendorId,
        procurementReference: input.procurementReference,
        storageLocation: input.storageLocation,
      },
    });
    revalidatePath("/", "layout");
    return { ok: true, lotId: lotId ?? undefined, batchNumber: batch };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not book that delivery in",
    };
  }
}

export async function createVendor(name: string): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (!name.trim()) throw new Error("A vendor needs a name");
    await db.insert(vendors).values({ name: name.trim() });
  });
}

/* ------------------------------ Routings ------------------------------ */

export async function addRoutingStep(input: {
  itemId: number;
  name: string;
  stationId: number | null;
  expectedMinutes: number | null;
  instructions?: string | null;
}): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (!input.name.trim()) throw new Error("A step needs a name");

    const [{ value }] = await db
      .select({ value: max(routingSteps.sequence) })
      .from(routingSteps)
      .where(eq(routingSteps.itemId, input.itemId));

    await db.insert(routingSteps).values({
      itemId: input.itemId,
      sequence: (value ?? 0) + 1,
      name: input.name.trim(),
      stationId: input.stationId,
      expectedMinutes: input.expectedMinutes,
      instructions: input.instructions?.trim() || null,
    });
  });
}

export async function deleteRoutingStep(stepId: number): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    // Detach from any tasks that referenced it — their own snapshot is what matters.
    await db.delete(routingSteps).where(eq(routingSteps.id, stepId));
  });
}

export async function moveRoutingStep(stepId: number, direction: -1 | 1): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    const step = await db.query.routingSteps.findFirst({ where: eq(routingSteps.id, stepId) });
    if (!step) throw new Error("Step not found");

    const siblings = await db
      .select()
      .from(routingSteps)
      .where(eq(routingSteps.itemId, step.itemId))
      .orderBy(asc(routingSteps.sequence));

    const idx = siblings.findIndex((s) => s.id === stepId);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;

    const other = siblings[swapIdx];
    await db
      .update(routingSteps)
      .set({ sequence: other.sequence })
      .where(eq(routingSteps.id, step.id));
    await db
      .update(routingSteps)
      .set({ sequence: step.sequence })
      .where(eq(routingSteps.id, other.id));
  });
}

/* -------------------------------- BOM --------------------------------- */

export async function addBomLine(input: {
  parentItemId: number;
  componentItemId: number;
  quantity: number;
  consumedAtRoutingStepId: number | null;
}): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (input.parentItemId === input.componentItemId) {
      throw new Error("An item cannot contain itself");
    }
    if (input.quantity < 1) throw new Error("Quantity must be at least 1");

    await db.insert(bomLines).values({
      parentItemId: input.parentItemId,
      componentItemId: input.componentItemId,
      quantity: input.quantity,
      consumedAtRoutingStepId: input.consumedAtRoutingStepId,
    });
  });
}

export async function deleteBomLine(lineId: number): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    await db.delete(bomLines).where(eq(bomLines.id, lineId));
  });
}

/* ------------------------------- People ------------------------------- */

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: "WORKER" | "FORKLIFT" | "SUPERVISOR" | "ADMIN";
  stationId: number | null;
}): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (!input.name.trim() || !input.email.trim()) throw new Error("Name and email are required");
    if (input.password.length < 8) throw new Error("Password must be at least 8 characters");

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email.toLowerCase().trim()));
    if (existing.length > 0) throw new Error("Someone already uses that email");

    await db.insert(users).values({
      name: input.name.trim(),
      email: input.email.toLowerCase().trim(),
      passwordHash: await bcrypt.hash(input.password, 10),
      role: input.role,
      stationId: input.stationId,
    });
  });
}

export async function setUserActive(id: number, active: boolean): Promise<ActionResult> {
  return wrap(async () => {
    const admin = await requireRole("ADMIN");
    if (admin.id === id && !active) throw new Error("You cannot deactivate your own account");
    await db.update(users).set({ active }).where(eq(users.id, id));
  });
}

/* ---------------------------- Reason codes ---------------------------- */

export async function createReasonCode(input: {
  category: "SCRAP" | "REWORK" | "DOWNTIME" | "BLOCKED";
  code: string;
  label: string;
}): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    if (!input.code.trim() || !input.label.trim()) throw new Error("Code and label are required");
    await db.insert(reasonCodes).values({
      category: input.category,
      code: input.code.trim().toUpperCase().replace(/\s+/g, "_"),
      label: input.label.trim(),
    });
  });
}

export async function setReasonCodeActive(id: number, active: boolean): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN");
    await db.update(reasonCodes).set({ active }).where(eq(reasonCodes.id, id));
  });
}

/* ---------------------------- Work orders ----------------------------- */

export async function createWorkOrder(input: {
  /** Optional. Left blank, the server allocates the next number in the series. */
  orderNumber?: string;
  itemId: number;
  customerId: number | null;
  quantity: number;
  dueDate: string | null;
  dimensions?: string | null;
  materialType?: string | null;
}): Promise<{ ok: true; orderId: number; orderNumber: string } | { ok: false; error: string }> {
  return wrapWith(async () => {
    const admin = await requireRole("ADMIN", "SUPERVISOR");
    if (input.quantity < 1) throw new Error("Quantity must be at least 1");

    const typed = input.orderNumber?.trim();

    // Allocating the number and inserting the row happen in one transaction, so
    // the advisory lock inside nextWorkOrderNumber still holds when the row lands.
    // Read it outside and two people raising an order in the same second get the
    // same number.
    const order = await db.transaction(async (tx) => {
      const orderNumber = typed && typed.length > 0 ? typed : await nextWorkOrderNumber({ tx });

      const clash = await tx
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(eq(workOrders.orderNumber, orderNumber));
      if (clash.length > 0) throw new Error("That work order number is already used");

      const [row] = await tx
        .insert(workOrders)
        .values({
          orderNumber,
          itemId: input.itemId,
          customerId: input.customerId,
          quantity: input.quantity,
          dimensions: input.dimensions?.trim() || null,
          materialType: input.materialType?.trim() || null,
          dueDate: dueDateFromInput(input.dueDate),
          status: "PLANNED",
          createdByUserId: admin.id,
        })
        .returning();
      return row;
    });

    // Releasing builds the task list and the whole sub-assembly tree.
    await releaseWorkOrder(order.id, admin.id);
    return { orderId: order.id, orderNumber: order.orderNumber };
  });
}

export async function createCustomer(name: string): Promise<ActionResult> {
  return wrap(async () => {
    await requireRole("ADMIN", "SUPERVISOR");
    if (!name.trim()) throw new Error("A customer needs a name");
    await db.insert(customers).values({ name: name.trim() });
  });
}

/** Same thing, but hands back the row so a form can select what it just created. */
export async function addCustomer(name: string) {
  return wrapWith(async () => {
    await requireRole("ADMIN", "SUPERVISOR");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("A customer needs a name");
    const [row] = await db
      .insert(customers)
      .values({ name: trimmed })
      .returning({ id: customers.id, name: customers.name });
    return { customer: row };
  });
}

/* ------------------------- Made-to-order ---------------------------- */

export type MadeToOrderInput = {
  customerId: number | null;
  productName: string;
  sku: string;
  quantity: number;
  dueDate: string | null;
  /** What the customer asked for, in their words. Free text — see the column comment. */
  dimensions?: string | null;
  materialType?: string | null;
  /**
   * What one unit is built from, each line attached to the step that consumes it.
   * `stepIndex` is a position in `steps` — you cut sheet at the laser and bolt at
   * assembly, and a material belonging to no step is issued at no step, which is
   * how a bill of materials silently becomes nothing.
   */
  materials: { itemId: number; quantity: number; stepIndex: number }[];
  /** The steps, in the order the job travels. */
  steps: { name: string; stationId: number | null; instructions?: string | null }[];
};

/**
 * Raise an order for something that has never been built before.
 *
 * The normal flow assumes the product already exists with a routing and a bill of
 * materials, which is right for a catalogue. It is wrong for a shop that builds to
 * order, where the drawing arrives with the purchase order and the product is new
 * every time — there, "pick a product" is a dead end, because the product is the
 * thing you are about to describe.
 *
 * So this defines the product and raises the order in ONE transaction: the item,
 * its steps, its bill of materials, then the work order itself. Either the whole
 * thing exists or none of it does — a half-defined product with an order against it
 * is worse than no order, because it releases onto the floor and cannot be built.
 */
export async function createMadeToOrder(
  input: MadeToOrderInput
): Promise<{ ok: true; orderId: number; orderNumber: string } | { ok: false; error: string }> {
  return wrapWith(async () => {
    const admin = await requireRole("ADMIN", "SUPERVISOR");

    const name = input.productName.trim();
    if (!name) throw new Error("Give the product a name");
    if (input.quantity < 1) throw new Error("Quantity must be at least 1");

    const steps = input.steps.filter((s) => s.name.trim());
    if (steps.length === 0) throw new Error("Add at least one step");

    const materials = input.materials.filter((m) => m.itemId > 0 && m.quantity > 0);

    // A SKU is what a person reads back on a traveler, so one is generated when
    // nobody supplies one rather than leaving the product unnameable.
    const sku =
      input.sku.trim() ||
      `MTO-${name.replace(/[^A-Za-z0-9]+/g, "-").toUpperCase().slice(0, 16)}-${Date.now()
        .toString(36)
        .slice(-4)
        .toUpperCase()}`;

    const clash = await db.select({ id: items.id }).from(items).where(eq(items.sku, sku));
    if (clash.length > 0) throw new Error(`The code ${sku} is already used`);

    const raised = await db.transaction(async (tx) => {
      const [product] = await tx
        .insert(items)
        .values({
          sku,
          name,
          procurementType: "MANUFACTURED",
          isFinishedGood: true,
          unitOfMeasure: "ea",
        })
        .returning();

      // Sequence in tens, so a step can be inserted between two later without
      // renumbering the whole routing.
      const createdSteps: number[] = [];
      for (const [i, step] of steps.entries()) {
        const [row] = await tx
          .insert(routingSteps)
          .values({
            itemId: product.id,
            sequence: (i + 1) * 10,
            name: step.name.trim(),
            stationId: step.stationId,
            instructions: step.instructions?.trim() || null,
          })
          .returning({ id: routingSteps.id });
        createdSteps.push(row.id);
      }

      for (const line of materials) {
        // Out of range, or never chosen, means the first step — the material is
        // needed to begin, which is the common case and never nowhere.
        const stepId =
          createdSteps[line.stepIndex] ?? createdSteps[0] ?? null;
        await tx.insert(bomLines).values({
          parentItemId: product.id,
          componentItemId: line.itemId,
          quantity: line.quantity,
          consumedAtRoutingStepId: stepId,
        });
      }

      const orderNumber = await nextWorkOrderNumber({ tx });
      const [order] = await tx
        .insert(workOrders)
        .values({
          orderNumber,
          itemId: product.id,
          customerId: input.customerId,
          quantity: input.quantity,
          dimensions: input.dimensions?.trim() || null,
          materialType: input.materialType?.trim() || null,
          dueDate: dueDateFromInput(input.dueDate),
          status: "PLANNED",
          createdByUserId: admin.id,
        })
        .returning();
      return { orderId: order.id, orderNumber };
    });

    // Releasing builds the steps and the material requirements for this order.
    await releaseWorkOrder(raised.orderId, admin.id);
    return raised;
  });
}
