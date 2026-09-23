import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { resetDatabase, uid } from "./helpers";
import { attachments, items, users, workOrders, workOrderTasks, stations } from "../src/db/schema";
import {
  attachmentsForOrder,
  attachmentsForTask,
  attachmentBytes,
  attachmentCountsForTasks,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
} from "../src/lib/attachments";
import { renderableInline } from "../src/lib/attachment-shared";

/*
  Drawings.

  The rule worth testing is inheritance: a sub-assembly order shows the unit's
  general arrangement, because somebody welding a frame is building part of one
  machine and needs to see its shape.
*/

let parentOrderId: number;
let childOrderId: number;
let childTaskId: number;
let authorId: number;

beforeEach(async () => {
  await resetDatabase();

  const [author] = await db
    .insert(users)
    .values({
      name: "Sam Supervisor",
      email: `sup-${uid("e")}@example.com`,
      passwordHash: "x",
      role: "SUPERVISOR",
    })
    .returning();
  authorId = author.id;

  const [unit] = await db
    .insert(items)
    .values({ sku: `AHU-${uid("s")}`, name: "Unit", procurementType: "MANUFACTURED" })
    .returning();
  const [frame] = await db
    .insert(items)
    .values({ sku: `FRM-${uid("s")}`, name: "Frame", procurementType: "MANUFACTURED" })
    .returning();
  const [station] = await db
    .insert(stations)
    .values({ name: `Fab-${uid("st")}`, number: 20 })
    .returning();

  const [parent] = await db
    .insert(workOrders)
    .values({ orderNumber: `WO-${uid("o")}`, itemId: unit.id, quantity: 1 })
    .returning();
  parentOrderId = parent.id;

  const [child] = await db
    .insert(workOrders)
    .values({
      orderNumber: `WO-${uid("o")}-01`,
      itemId: frame.id,
      quantity: 1,
      parentWorkOrderId: parent.id,
      level: 1,
    })
    .returning();
  childOrderId = child.id;

  const [task] = await db
    .insert(workOrderTasks)
    .values({ workOrderId: child.id, sequence: 1, name: "Weld frame", stationId: station.id })
    .returning();
  childTaskId = task.id;
});

after(async () => {
  await pool.end();
});

async function addDrawing(over: {
  workOrderId?: number;
  workOrderTaskId?: number;
  title?: string;
  revision?: string;
  bytes?: Buffer;
}) {
  const content = over.bytes ?? Buffer.from("%PDF-1.4 fake drawing");
  const [row] = await db
    .insert(attachments)
    .values({
      workOrderId: over.workOrderId ?? null,
      workOrderTaskId: over.workOrderTaskId ?? null,
      title: over.title ?? "GA drawing",
      fileName: "ga.pdf",
      mimeType: "application/pdf",
      content,
      sizeBytes: content.byteLength,
      revision: over.revision ?? "C",
      uploadedByUserId: authorId,
    })
    .returning({ id: attachments.id });
  return row.id;
}

test("a sub-assembly inherits the unit's drawing", async () => {
  await addDrawing({ workOrderId: parentOrderId, title: "Unit GA" });

  const onChild = await attachmentsForOrder(childOrderId);
  assert.equal(onChild.length, 1, "the frame order sees the unit's drawing");
  assert.equal(onChild[0].title, "Unit GA");
});

test("a drawing on a sub-assembly does NOT leak up to the unit", async () => {
  await addDrawing({ workOrderId: childOrderId, title: "Frame detail" });

  const onParent = await attachmentsForOrder(parentOrderId);
  assert.equal(onParent.length, 0, "detail for one part is not the unit's drawing");
});

test("a step shows the unit drawing and its own, without repeating either", async () => {
  await addDrawing({ workOrderId: parentOrderId, title: "Unit GA" });
  await addDrawing({ workOrderId: childOrderId, title: "Frame detail" });
  await addDrawing({ workOrderTaskId: childTaskId, title: "Weld sequence" });

  const forStep = await attachmentsForTask(childTaskId, childOrderId);
  const titles = forStep.map((f) => f.title).sort();
  assert.deepEqual(titles, ["Frame detail", "Unit GA", "Weld sequence"]);
  assert.equal(new Set(forStep.map((f) => f.id)).size, 3, "nothing listed twice");
});

test("the revision travels with the drawing", async () => {
  await addDrawing({ workOrderId: parentOrderId, revision: "D" });
  const [file] = await attachmentsForOrder(parentOrderId);
  assert.equal(file.revision, "D");
});

test("listing drawings never loads the file itself", async () => {
  const big = Buffer.alloc(200_000, 7);
  await addDrawing({ workOrderId: parentOrderId, bytes: big });

  const list = await attachmentsForOrder(parentOrderId);
  assert.equal(list[0].sizeBytes, 200_000, "the size is known");
  assert.equal(
    "content" in list[0],
    false,
    "but the bytes are not in the row — a list must not pull whole PDFs into memory"
  );
});

test("opening a drawing returns the exact bytes that went in", async () => {
  const original = Buffer.from("%PDF-1.4 the real thing\n%%EOF");
  const id = await addDrawing({ workOrderId: parentOrderId, bytes: original });

  const file = await attachmentBytes(id);
  assert.ok(file);
  assert.equal(file.mimeType, "application/pdf");
  assert.deepEqual(file.content, original, "byte-for-byte");
});

test("a drawing that does not exist is absent, not a crash", async () => {
  assert.equal(await attachmentBytes(999_999), null);
});

test("counts per step come back without reading any file", async () => {
  await addDrawing({ workOrderTaskId: childTaskId });
  await addDrawing({ workOrderTaskId: childTaskId });

  const counts = await attachmentCountsForTasks([childTaskId]);
  assert.equal(counts.get(childTaskId), 2);
});

test("deleting a drawing removes it from the order", async () => {
  const id = await addDrawing({ workOrderId: parentOrderId });
  await db.delete(attachments).where(eq(attachments.id, id));
  assert.equal((await attachmentsForOrder(parentOrderId)).length, 0);
});

test("file sizes are written for humans", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024);
});

test("a drawing a browser can safely draw is rendered", () => {
  assert.equal(renderableInline("application/pdf"), true);
  assert.equal(renderableInline("image/png"), true);
  assert.equal(renderableInline("IMAGE/JPEG"), true);
  assert.equal(renderableInline("image/png; charset=binary"), true);
});

test("anything that can carry script is downloaded, never rendered", () => {
  // Served from our own origin, so rendering these would run the uploader's code.
  assert.equal(renderableInline("image/svg+xml"), false);
  assert.equal(renderableInline("text/html"), false);
  assert.equal(renderableInline("application/xhtml+xml"), false);
  assert.equal(renderableInline("text/javascript"), false);
  assert.equal(renderableInline("application/octet-stream"), false);
  assert.equal(renderableInline(null), false);
  assert.equal(renderableInline(""), false);
});
