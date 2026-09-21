"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markLoaded } from "@/app/actions/loading";
import type { LoadableUnit } from "@/lib/loading";
import { Panel, EmptyState } from "@/components/ui";

/**
 * The forklift driver's whole screen.
 *
 * What is built, where it sits, and one button. A second press confirms, because
 * saying a pallet is on a truck when it is not is the one mistake that is hard to
 * find again.
 */
export function LoadingList({ units }: { units: LoadableUnit[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  function load(u: LoadableUnit) {
    if (pending || !u.orderId) return;
    setMessage(null);
    startTransition(async () => {
      const res = await markLoaded({ orderId: u.orderId! });
      if (!res.ok) {
        setMessage({ error: true, text: res.error });
        return;
      }
      setConfirming(null);
      setMessage({ error: false, text: `${u.itemName} loaded — ${res.noteNumber}.` });
      router.refresh();
    });
  }

  const waiting = units.filter((u) => u.noteStatus !== "PICKED_UP" && u.noteStatus !== "DELIVERED");
  const gone = units.filter((u) => u.noteStatus === "PICKED_UP" || u.noteStatus === "DELIVERED");

  return (
    <div className="space-y-6">
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`rounded-md px-4 py-3 text-sm ${
            message.error ? "bg-blocked-bg text-blocked-fg" : "bg-ok-bg text-ok-fg"
          }`}
        >
          {message.text}
        </p>
      )}

      {waiting.length === 0 ? (
        <EmptyState
          title="Nothing to load"
          hint="Finished units appear here as soon as their last step is signed off."
        />
      ) : (
        <div className="space-y-3">
          {waiting.map((u) => (
            <Panel key={u.lotId} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-lg font-semibold text-steel-900">{u.itemName}</p>
                  <p className="tnum mt-0.5 text-sm text-steel-500">
                    {u.orderNumber ?? u.batchNumber}
                    {u.customerName ? ` · ${u.customerName}` : ""}
                  </p>
                  <p className="mt-1 text-sm text-steel-600">
                    <span className="tnum font-medium">
                      {u.quantity} {u.unit}
                    </span>
                    {u.storageLocation ? ` · ${u.storageLocation}` : ""}
                  </p>
                </div>
              </div>

              <div className="mt-4">
                {confirming === u.lotId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-steel-600">On the truck?</span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => load(u)}
                      className="inline-flex min-h-14 items-center rounded-lg bg-navy-800 px-6 text-base font-medium text-white disabled:opacity-50"
                    >
                      {pending ? "Saving…" : "Yes, loaded"}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirming(null)}
                      className="inline-flex min-h-14 items-center rounded-lg border border-steel-300 bg-white px-6 text-base text-steel-700"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={pending || !u.orderId}
                    onClick={() => setConfirming(u.lotId)}
                    className="inline-flex min-h-14 items-center rounded-lg bg-navy-800 px-8 text-base font-medium text-white disabled:opacity-50"
                  >
                    Loaded
                  </button>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}

      {gone.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-steel-400">
            Already gone
          </p>
          <Panel className="divide-y divide-steel-100">
            {gone.map((u) => (
              <div key={u.lotId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <span className="text-sm text-steel-600">{u.itemName}</span>
                <span className="tnum text-xs text-steel-400">{u.noteNumber}</span>
              </div>
            ))}
          </Panel>
        </section>
      )}
    </div>
  );
}
