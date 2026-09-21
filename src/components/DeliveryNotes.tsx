"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveDeliveryNote, raiseDeliveryNote } from "@/app/actions/delivery";
import type { DeliveryRow, DeliveryStatus, ShippableOrder } from "@/lib/delivery";
import { Button, Chip, EmptyState, Panel, TD, TH, TR, formatWhen } from "@/components/ui";

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  UNASSIGNED: "Unassigned",
  ALLOCATED: "Allocated",
  PICKED_UP: "Picked up",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const STATUS_TONE: Record<DeliveryStatus, "neutral" | "alert" | "quiet"> = {
  UNASSIGNED: "alert",
  ALLOCATED: "neutral",
  PICKED_UP: "neutral",
  DELIVERED: "quiet",
  CANCELLED: "quiet",
};

/** The states a note can be moved TO. UNASSIGNED is where it starts, never a target. */
type MoveTarget = "ALLOCATED" | "PICKED_UP" | "DELIVERED" | "CANCELLED";

/** The one move that makes sense next, rather than a row of buttons. */
function nextMove(status: DeliveryStatus): { to: MoveTarget; label: string } | null {
  switch (status) {
    case "UNASSIGNED":
      return { to: "ALLOCATED", label: "Allocate" };
    case "ALLOCATED":
      return { to: "PICKED_UP", label: "Picked up" };
    case "PICKED_UP":
      return { to: "DELIVERED", label: "Delivered" };
    default:
      return null;
  }
}

export function RaiseDeliveryNoteForm({
  shippable,
  handlers,
}: {
  shippable: ShippableOrder[];
  handlers: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [orderId, setOrderId] = useState<number | null>(shippable[0]?.orderId ?? null);
  const order = shippable.find((s) => s.orderId === orderId) ?? null;
  const [quantity, setQuantity] = useState(order?.remaining ?? 1);
  const [handlerId, setHandlerId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  if (shippable.length === 0) {
    return (
      <Panel className="px-5 py-4">
        <p className="text-sm text-steel-500">
          Nothing is ready to ship. An order appears here once it exists and is not already
          fully covered by delivery notes.
        </p>
      </Panel>
    );
  }

  function submit() {
    if (pending || !orderId) return;
    setMessage(null);
    startTransition(async () => {
      const res = await raiseDeliveryNote({
        workOrderId: orderId!,
        quantity,
        handlerUserId: handlerId,
        notes: notes.trim() || undefined,
      });
      if (!res.ok) {
        setMessage({ error: true, text: res.error });
        return;
      }
      setMessage({ error: false, text: `${res.result.noteNumber} raised.` });
      setNotes("");
      router.refresh();
    });
  }

  return (
    <Panel className="px-5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 text-sm text-steel-600">
          Order
          <select
            className="mt-1 block min-h-11 w-full rounded-md border border-steel-300 bg-white px-3"
            value={orderId ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value);
              setOrderId(id);
              setQuantity(shippable.find((s) => s.orderId === id)?.remaining ?? 1);
            }}
          >
            {shippable.map((s) => (
              <option key={s.orderId} value={s.orderId}>
                {s.orderNumber} — {s.itemName} ({s.remaining} left)
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm text-steel-600">
          Quantity
          <input
            type="number"
            min={1}
            max={order?.remaining ?? 1}
            className="tnum mt-1 block min-h-11 w-28 rounded-md border border-steel-300 bg-white px-3"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>

        <label className="text-sm text-steel-600">
          Handler
          <select
            className="mt-1 block min-h-11 rounded-md border border-steel-300 bg-white px-3"
            value={handlerId ?? ""}
            onChange={(e) => setHandlerId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Not yet assigned</option>
            {handlers.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-52 flex-1 text-sm text-steel-600">
          Note
          <input
            className="mt-1 block min-h-11 w-full rounded-md border border-steel-300 bg-white px-3"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Gate 3, ask for Priya"
          />
        </label>

        <Button tone="primary" disabled={pending || !orderId} onClick={submit}>
          {pending ? "Raising…" : "Raise note"}
        </Button>
      </div>

      {order && order.stepsOutstanding > 0 && (
        <p className="mt-3 text-sm text-steel-500">
          {order.orderNumber} still has {order.stepsOutstanding} step
          {order.stepsOutstanding === 1 ? "" : "s"} unfinished. Raising a note now records
          the promise, not the goods.
        </p>
      )}

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-3 text-sm ${message.error ? "text-blocked-fg" : "text-ok-fg"}`}
        >
          {message.text}
        </p>
      )}
    </Panel>
  );
}

export function DeliveryNoteTable({
  notes,
  handlers,
  canDispatch,
}: {
  notes: DeliveryRow[];
  handlers: { id: number; name: string }[];
  canDispatch: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Who each unassigned row is about to be given to. Picking someone on the
  // operator's behalf — the first name in the list — would put a real person's
  // name against a parcel they know nothing about, so the row asks instead.
  const [picked, setPicked] = useState<Record<number, number>>({});

  function move(note: DeliveryRow, to: MoveTarget) {
    if (pending) return;
    setError(null);
    const handlerUserId = to === "ALLOCATED" && !note.handlerName ? picked[note.id] : undefined;
    if (to === "ALLOCATED" && !note.handlerName && !handlerUserId) {
      setError(`${note.noteNumber}: choose who is handling it first.`);
      return;
    }
    setBusy(note.id);
    startTransition(async () => {
      const res = await moveDeliveryNote({ noteId: note.id, to, handlerUserId });
      if (!res.ok) setError(`${note.noteNumber}: ${res.error}`);
      else router.refresh();
      setBusy(null);
    });
  }

  if (notes.length === 0) {
    return (
      <div className="mt-5">
        <EmptyState
          title="No delivery notes"
          hint="Raise one above when a finished order is ready to leave the building."
        />
      </div>
    );
  }

  return (
    <div className="mt-5">
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-blocked-bg px-4 py-2 text-sm text-blocked-fg">
          {error}
        </p>
      )}
      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem]">
            <thead className="bg-steel-50/60">
              <tr className="border-b border-steel-200">
                <th className={TH}>Note</th>
                <th className={TH}>Order</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={TH}>Status</th>
                <th className={TH}>Handler</th>
                <th className={TH}>Raised</th>
                {canDispatch && <th className={`${TH} text-right`}>Next</th>}
              </tr>
            </thead>
            <tbody>
              {notes.map((n) => {
                const next = nextMove(n.status);
                return (
                  <tr key={n.id} className={TR}>
                    <td className={`${TD} tnum font-medium text-steel-900`}>
                      {n.noteNumber}
                      {n.notes && <p className="mt-0.5 text-xs text-steel-400">{n.notes}</p>}
                    </td>
                    <td className={TD}>
                      <Link
                        href={`/orders/${n.orderId}`}
                        className="inline-flex min-h-11 items-center text-steel-700 underline-offset-2 hover:text-navy-800 hover:underline"
                      >
                        {n.itemName}
                      </Link>
                      <p className="mt-0.5 text-xs text-steel-400">
                        <Link
                          href={`/orders/${n.orderId}`}
                          className="tnum underline underline-offset-2 hover:text-navy-800"
                        >
                          {n.orderNumber}
                        </Link>
                        {n.customerName ? ` · ${n.customerName}` : ""}
                      </p>
                    </td>
                    <td className={`${TD} tnum text-right text-steel-700`}>{n.quantity}</td>
                    <td className={TD}>
                      <Chip tone={STATUS_TONE[n.status]}>{STATUS_LABEL[n.status]}</Chip>
                      {n.deliveredAt && (
                        <p className="mt-0.5 text-xs text-steel-400">{formatWhen(n.deliveredAt)}</p>
                      )}
                    </td>
                    <td className={`${TD} text-steel-600`}>
                      {n.handlerName ??
                        (canDispatch && n.status === "UNASSIGNED" ? (
                          <select
                            aria-label={`Handler for ${n.noteNumber}`}
                            className="min-h-11 rounded-md border border-steel-300 bg-white px-2 text-sm"
                            value={picked[n.id] ?? ""}
                            onChange={(e) =>
                              setPicked((old) => ({ ...old, [n.id]: Number(e.target.value) }))
                            }
                          >
                            <option value="">Choose…</option>
                            {handlers.map((h) => (
                              <option key={h.id} value={h.id}>
                                {h.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-steel-400">Nobody yet</span>
                        ))}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-steel-500`}>
                      {formatWhen(n.createdAt)}
                    </td>
                    {canDispatch && (
                      <td className={`${TD} text-right`}>
                        {next ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button disabled={pending} onClick={() => move(n, next.to)}>
                              {busy === n.id ? "…" : next.label}
                            </Button>
                            {n.status !== "PICKED_UP" && (
                              <Button disabled={pending} onClick={() => move(n, "CANCELLED")}>
                                Cancel
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-steel-400">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
