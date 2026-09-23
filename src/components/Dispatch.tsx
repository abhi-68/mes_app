"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { markShipped } from "@/app/actions/loading";
import { Panel, Button, StatusPill } from "@/components/ui";

export type DispatchRow = {
  id: number;
  orderNumber: string;
  itemName: string;
  customerName: string | null;
  quantity: number;
  status: string;
  noteNumber: string | null;
  handlerName: string | null;
};

/**
 * Built units and where they are.
 *
 * This used to be its own Dispatch screen with its own delivery-note vocabulary.
 * A supervisor asking "has the Gulf Coast unit gone out?" is asking about the
 * order, so the answer belongs on the order, not on a second list keyed by a note
 * number the customer has never heard of.
 */
export function Dispatch({ rows, canShip }: { rows: DispatchRow[]; canShip: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) return null;

  const waiting = rows.filter((r) => r.status === "DONE");
  const gone = rows.filter((r) => r.status === "IN_TRANSIT");

  function ship(row: DispatchRow) {
    setError(null);
    start(async () => {
      const res = await markShipped({ orderId: row.id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Panel className="mt-6 p-5">
      <h2 className="text-sm font-semibold text-gray-950">Built and going out</h2>

      {waiting.length > 0 && (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">
            Waiting for a truck
          </p>
          <ul className="mt-2 space-y-2">
            {waiting.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50/60 px-4 py-3"
              >
                <div>
                  <Link
                    href={`/orders/${r.id}`}
                    className="text-sm font-medium text-gray-900 underline"
                  >
                    {r.orderNumber}
                  </Link>
                  <p className="text-xs text-gray-500">
                    {r.itemName} × {r.quantity}
                    {r.customerName ? ` · ${r.customerName}` : ""}
                  </p>
                </div>
                <span className="text-xs text-gray-400">
                  A driver marks this loaded on their own screen
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {gone.length > 0 && (
        <>
          <p className="mt-4 text-xs font-medium uppercase tracking-wide text-gray-400">
            On the road
          </p>
          <ul className="mt-2 space-y-2">
            {gone.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50/60 px-4 py-3"
              >
                <div>
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/orders/${r.id}`}
                      className="text-sm font-medium text-gray-900 underline"
                    >
                      {r.orderNumber}
                    </Link>
                    <StatusPill status={r.status} size="sm" />
                  </span>
                  <p className="text-xs text-gray-500">
                    {r.itemName} × {r.quantity}
                    {r.customerName ? ` · ${r.customerName}` : ""}
                    {r.handlerName ? ` · loaded by ${r.handlerName}` : ""}
                  </p>
                </div>
                {canShip && (
                  <Button size="sm" disabled={pending} onClick={() => ship(r)}>
                    Customer has it
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger-700">
          {error}
        </p>
      )}
    </Panel>
  );
}
