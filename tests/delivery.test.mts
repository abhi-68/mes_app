import "dotenv/config";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { deliveryNotes, items, stations, users, workOrders } from "../src/db/schema.ts";
import { resetDatabase } from "./helpers.ts";
import {
  advanceDeliveryNote, createDeliveryNote, deliveryNoteList, remainingToShip,
  shippableOrders,
} from "../src/lib/delivery.ts";
import { CommandError } from "../src/lib/inventory.ts";

if (!(process.env.DATABASE_URL ?? "").includes("mes_test")) {
  throw new Error("Refusing to run: DATABASE_URL must point at mes_test. Use `npm test`.");
}

after(async () => {
  await pool.end();
});

let orderId = 0;
let actorId = 0;
let handlerId = 0;

beforeEach(async () => {
  await resetDatabase();
  const [station] = await db.insert(stations).values({ name: "QC / Dispatch" }).returning();
  const [actor] = await db.insert(users).values({
    name: "Sam Supervisor", email: "sup@test.invalid", passwordHash: "x",
    role: "SUPERVISOR", stationId: station.id,
  }).returning();
  const [handler] = await db.insert(users).values({
    name: "Dana Driver", email: "driver@test.invalid", passwordHash: "x",
    role: "WORKER", stationId: station.id,
  }).returning();
  actorId = actor.id;
  handlerId = handler.id;

  const [item] = await db.insert(items).values({
    sku: "FG-AHU", name: "Air Handling Unit", procurementType: "MANUFACTURED", isFinishedGood: true,
  }).returning();
  const [order] = await db.insert(workOrders).values({
    orderNumber: "WO-260920-001", itemId: item.id, quantity: 10, status: "DONE",
  }).returning();
  orderId = order.id;
});

const raise = (quantity: number, handler: number | null = null) =>
  createDeliveryNote({ workOrderId: orderId, quantity, handlerUserId: handler, actorUserId: actorId });

const statusOf = async (id: number) =>
  (await db.select().from(deliveryNotes).where(eq(deliveryNotes.id, id)))[0].status;

test("a note is numbered DN-YYMMDD-NNN and starts unassigned", async () => {
  const note = await raise(4);
  assert.match(note.noteNumber, /^DN-\d{6}-001$/);
  assert.equal(await statusOf(note.id), "UNASSIGNED");
});

test("naming a handler when raising it means it is allocated", async () => {
  const note = await raise(4, handlerId);
  assert.equal(await statusOf(note.id), "ALLOCATED");
});

test("you cannot promise more than the order", async () => {
  await assert.rejects(() => raise(11), (e: Error) => {
    assert.ok(e instanceof CommandError);
    assert.match(e.message, /Only 10 left/);
    return true;
  });
  assert.equal((await db.select().from(deliveryNotes)).length, 0, "nothing was written");
});

test("notes accumulate against the order until it is fully promised", async () => {
  await raise(6);
  assert.deepEqual(await remainingToShip(orderId), { quantity: 10, promised: 6, remaining: 4 });
  await raise(4);
  assert.equal((await remainingToShip(orderId)).remaining, 0);
  await assert.rejects(() => raise(1), /already on a delivery note/);
});

test("a cancelled note releases the quantity it was holding", async () => {
  const note = await raise(10);
  assert.equal((await remainingToShip(orderId)).remaining, 0);
  await advanceDeliveryNote({ noteId: note.id, to: "CANCELLED", actorUserId: actorId });
  assert.equal((await remainingToShip(orderId)).remaining, 10, "the units are shippable again");
  await raise(10);
});

test("two notes raised at the same instant cannot oversell the order", async () => {
  // The reason the order row is locked. Each wants the whole order.
  const results = await Promise.allSettled([raise(10), raise(10)]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one may have it");
  assert.equal((await db.select().from(deliveryNotes)).length, 1);
  assert.equal((await remainingToShip(orderId)).remaining, 0);
});

test("status moves forward one step at a time", async () => {
  const note = await raise(4, handlerId);
  await advanceDeliveryNote({ noteId: note.id, to: "PICKED_UP", actorUserId: actorId });
  assert.equal(await statusOf(note.id), "PICKED_UP");
  await advanceDeliveryNote({ noteId: note.id, to: "DELIVERED", actorUserId: actorId });
  assert.equal(await statusOf(note.id), "DELIVERED");
});

test("it cannot skip a step, go backwards, or move after delivery", async () => {
  const a = await raise(2, handlerId);
  await assert.rejects(
    () => advanceDeliveryNote({ noteId: a.id, to: "DELIVERED", actorUserId: actorId }),
    /picked up first/
  );

  const b = await raise(2, handlerId);
  await advanceDeliveryNote({ noteId: b.id, to: "PICKED_UP", actorUserId: actorId });
  await assert.rejects(
    () => advanceDeliveryNote({ noteId: b.id, to: "ALLOCATED", actorUserId: actorId }),
    /only moves forward/
  );

  await advanceDeliveryNote({ noteId: b.id, to: "DELIVERED", actorUserId: actorId });
  await assert.rejects(
    () => advanceDeliveryNote({ noteId: b.id, to: "DELIVERED", actorUserId: actorId }),
    /already delivered/
  );
});

test("nobody carries it anonymously", async () => {
  const note = await raise(3);
  await assert.rejects(
    () => advanceDeliveryNote({ noteId: note.id, to: "ALLOCATED", actorUserId: actorId }),
    /Name who is handling it/
  );
  await advanceDeliveryNote({
    noteId: note.id, to: "ALLOCATED", handlerUserId: handlerId, actorUserId: actorId,
  });
  assert.equal(await statusOf(note.id), "ALLOCATED");
});

test("goods already gone are delivered, not cancelled", async () => {
  const note = await raise(3, handlerId);
  await advanceDeliveryNote({ noteId: note.id, to: "PICKED_UP", actorUserId: actorId });
  await assert.rejects(
    () => advanceDeliveryNote({ noteId: note.id, to: "CANCELLED", actorUserId: actorId }),
    /already left/
  );
});

test("delivery stamps the time, and the list reads back what happened", async () => {
  const note = await raise(5, handlerId);
  await advanceDeliveryNote({ noteId: note.id, to: "PICKED_UP", actorUserId: actorId });
  await advanceDeliveryNote({ noteId: note.id, to: "DELIVERED", actorUserId: actorId });

  const [row] = await db.select().from(deliveryNotes).where(eq(deliveryNotes.id, note.id));
  assert.ok(row.pickedUpAt instanceof Date);
  assert.ok(row.deliveredAt instanceof Date);

  const [listed] = await deliveryNoteList();
  assert.equal(listed.noteNumber, note.noteNumber);
  assert.equal(listed.status, "DELIVERED");
  assert.equal(listed.handlerName, "Dana Driver");
  assert.equal(listed.itemName, "Air Handling Unit");
  assert.deepEqual(await deliveryNoteList("UNASSIGNED"), []);
});

test("an order drops off the shippable list once it is fully promised", async () => {
  const before = await shippableOrders();
  assert.equal(before.length, 1);
  assert.equal(before[0].remaining, 10);

  await raise(10);
  assert.deepEqual(await shippableOrders(), [], "nothing left to ship");
});

test("a cancelled order cannot be shipped", async () => {
  await db.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, orderId));
  await assert.rejects(() => raise(1), /cancelled/);
});

test("a quantity of zero or less is refused by the command and by the database", async () => {
  await assert.rejects(() => raise(0), /at least 1/);
  // The database refuses it too, so a future code path that forgets the guard
  // still cannot write a delivery note for a negative quantity. Drizzle wraps the
  // driver error, so the constraint name is on the cause rather than the message.
  await assert.rejects(
    () => db.insert(deliveryNotes).values({
      noteNumber: "DN-BAD", workOrderId: orderId, quantity: -1,
    }),
    (err: Error & { cause?: { constraint?: string } }) => {
      const constraint =
        err.cause?.constraint ?? `${err.message}${JSON.stringify(err.cause ?? "")}`;
      assert.match(String(constraint), /chk_delivery_quantity_positive/);
      return true;
    }
  );
  assert.equal((await db.select().from(deliveryNotes)).length, 0, "nothing was written");
});
