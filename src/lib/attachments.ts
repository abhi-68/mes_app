import { asc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { attachments, users, workOrders } from "@/db/schema";
import type { Exec } from "@/lib/inventory";
import type { AttachmentSummary } from "@/lib/attachment-shared";

/**
 * Drawings and work instructions.
 *
 * THE BYTES ARE NEVER SELECTED BY A LIST. Every query here names its columns and
 * leaves `content` out; a `select()` on this table pulls whole PDFs into memory to
 * render a filename. Only `attachmentBytes` reads it, and only when someone has
 * asked to open one.
 */

export { MAX_ATTACHMENT_BYTES, formatBytes } from "@/lib/attachment-shared";
export type { AttachmentSummary } from "@/lib/attachment-shared";

const summaryColumns = {
  id: attachments.id,
  title: attachments.title,
  fileName: attachments.fileName,
  mimeType: attachments.mimeType,
  sizeBytes: attachments.sizeBytes,
  revision: attachments.revision,
  uploadedBy: users.name,
  createdAt: attachments.createdAt,
  workOrderTaskId: attachments.workOrderTaskId,
};

/**
 * Everything a person working on this order is entitled to see.
 *
 * Sub-assembly orders inherit the top-level unit's drawings. Somebody welding a
 * frame is building part of one machine, and the general arrangement is how they
 * check that what is in front of them is the right shape — asking them to navigate
 * to the parent order to find it is how it stops being looked at.
 */
export async function attachmentsForOrder(
  workOrderId: number,
  exec: Exec = {}
): Promise<AttachmentSummary[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  const [order] = await database
    .select({ id: workOrders.id, parentWorkOrderId: workOrders.parentWorkOrderId })
    .from(workOrders)
    .where(eq(workOrders.id, workOrderId));
  if (!order) return [];

  const lineage: number[] = [order.id];
  let parentId = order.parentWorkOrderId;
  for (let i = 0; i < 20 && parentId != null; i++) {
    lineage.push(parentId);
    const [parent] = await database
      .select({ parentWorkOrderId: workOrders.parentWorkOrderId })
      .from(workOrders)
      .where(eq(workOrders.id, parentId));
    parentId = parent?.parentWorkOrderId ?? null;
  }

  return database
    .select(summaryColumns)
    .from(attachments)
    .leftJoin(users, eq(users.id, attachments.uploadedByUserId))
    .where(inArray(attachments.workOrderId, lineage))
    .orderBy(asc(attachments.createdAt));
}

/** The order-wide drawings plus anything pinned to this one step. */
export async function attachmentsForTask(
  workOrderTaskId: number,
  workOrderId: number,
  exec: Exec = {}
): Promise<AttachmentSummary[]> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const orderWide = await attachmentsForOrder(workOrderId, exec);

  const stepSpecific = await database
    .select(summaryColumns)
    .from(attachments)
    .leftJoin(users, eq(users.id, attachments.uploadedByUserId))
    .where(eq(attachments.workOrderTaskId, workOrderTaskId))
    .orderBy(asc(attachments.createdAt));

  const seen = new Set(orderWide.map((a) => a.id));
  return [...orderWide, ...stepSpecific.filter((a) => !seen.has(a.id))];
}

/** Only what is pinned to each step, without the order-wide drawings it inherits. */
export async function stepAttachments(
  taskIds: number[],
  exec: Exec = {}
): Promise<Map<number, AttachmentSummary[]>> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const byTask = new Map<number, AttachmentSummary[]>();
  if (taskIds.length === 0) return byTask;

  const rows = await database
    .select(summaryColumns)
    .from(attachments)
    .leftJoin(users, eq(attachments.uploadedByUserId, users.id))
    .where(inArray(attachments.workOrderTaskId, taskIds))
    .orderBy(asc(attachments.id));

  for (const row of rows) {
    if (row.workOrderTaskId == null) continue;
    const list = byTask.get(row.workOrderTaskId) ?? [];
    list.push(row);
    byTask.set(row.workOrderTaskId, list);
  }
  return byTask;
}

/** Counts for a list of steps, so a card can show a badge without loading files. */
export async function attachmentCountsForTasks(
  taskIds: number[],
  exec: Exec = {}
): Promise<Map<number, number>> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  if (taskIds.length === 0) return new Map();
  const rows = await database
    .select({
      taskId: attachments.workOrderTaskId,
      n: sql<number>`count(*)::int`,
    })
    .from(attachments)
    .where(inArray(attachments.workOrderTaskId, taskIds))
    .groupBy(attachments.workOrderTaskId);
  return new Map(rows.filter((r) => r.taskId != null).map((r) => [r.taskId!, r.n]));
}

/** The file itself. The only read that touches `content`. */
export async function attachmentBytes(
  id: number,
  exec: Exec = {}
): Promise<{ fileName: string; mimeType: string | null; content: Buffer } | null> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const [row] = await database
    .select({
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      content: attachments.content,
    })
    .from(attachments)
    .where(eq(attachments.id, id));
  if (!row?.content) return null;
  return { fileName: row.fileName, mimeType: row.mimeType, content: row.content };
}

/** Which order a drawing hangs off, for permission checks. */
export async function attachmentOwner(
  id: number,
  exec: Exec = {}
): Promise<{ workOrderId: number | null; workOrderTaskId: number | null } | null> {
  const database = exec.tx ?? exec.db ?? defaultDb;
  const [row] = await database
    .select({
      workOrderId: attachments.workOrderId,
      workOrderTaskId: attachments.workOrderTaskId,
    })
    .from(attachments)
    .where(eq(attachments.id, id));
  return row ?? null;
}
