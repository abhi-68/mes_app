"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, workOrders, workOrderTasks } from "@/db/schema";
import { requireUser, requireRole } from "@/lib/session";
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachment-shared";

export type UploadResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * Put a drawing on an order, or on one step of it.
 *
 * Raising a drawing is an office job, so it needs SUPERVISOR or ADMIN. Reading one
 * is not gated at all beyond being signed in — the whole point is that everybody
 * building the unit is looking at the same sheet.
 */
export async function uploadAttachment(form: FormData): Promise<UploadResult> {
  try {
    const user = await requireRole("SUPERVISOR", "ADMIN");

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Choose a file" };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 8 MB — upload a flattened PDF rather than the native drawing.`,
      };
    }

    const workOrderId = Number(form.get("workOrderId")) || null;
    const workOrderTaskId = Number(form.get("workOrderTaskId")) || null;
    if (!workOrderId && !workOrderTaskId) {
      return { ok: false, error: "A drawing has to belong to an order or a step" };
    }

    if (workOrderId) {
      const [order] = await db
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(eq(workOrders.id, workOrderId));
      if (!order) return { ok: false, error: "That order does not exist" };
    }
    if (workOrderTaskId) {
      const [task] = await db
        .select({ id: workOrderTasks.id })
        .from(workOrderTasks)
        .where(eq(workOrderTasks.id, workOrderTaskId));
      if (!task) return { ok: false, error: "That step does not exist" };
    }

    const title = String(form.get("title") ?? "").trim() || null;
    const revision = String(form.get("revision") ?? "").trim() || null;
    const content = Buffer.from(await file.arrayBuffer());

    const [row] = await db
      .insert(attachments)
      .values({
        workOrderId,
        workOrderTaskId,
        title,
        fileName: file.name.slice(0, 300),
        mimeType: file.type || null,
        content,
        sizeBytes: content.byteLength,
        revision,
        uploadedByUserId: user.id,
      })
      .returning({ id: attachments.id });

    revalidatePath("/", "layout");
    return { ok: true, id: row.id };
  } catch {
    return { ok: false, error: "Could not save that file" };
  }
}

/**
 * Remove a drawing.
 *
 * A superseded revision is worth deleting — two revisions of the same sheet on one
 * order is exactly how the wrong one gets built. History is not kept: nobody has
 * asked for a drawing archive, and pretending to have one would be worse than the
 * plain deletion this is.
 */
export async function deleteAttachment(id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireRole("SUPERVISOR", "ADMIN");
    await db.delete(attachments).where(eq(attachments.id, id));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not remove that file" };
  }
}

/** Signed-in is the whole check — see uploadAttachment. */
export async function assertCanReadAttachments(): Promise<void> {
  await requireUser();
}
