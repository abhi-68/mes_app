"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { scrapFinishedWork } from "@/app/actions/quality";
import { Panel, Button } from "@/components/ui";

export type FinishedJob = {
  id: number;
  name: string;
  jobNumber: string;
  orderId: number;
  orderNumber: string;
  itemName: string;
  finishedAt: string;
  /** Units of this step's output that can still be written off here. */
  writableOff: number;
  /** Already fitted into the next assembly, so it cannot be written off from here. */
  fitted: number;
};

/**
 * What this station finished recently, and a way to say one of them was wrong.
 *
 * A mistake is usually found after the step is done — the part is on the bench, or
 * the next person picks it up and it does not fit. Until this existed, the only
 * record of that was a supervisor on the quality screen, and only for parts that
 * happened to need inspection. Everything else was simply accepted and gone.
 */
export function FinishedWork({
  jobs,
  scrapReasons,
}: {
  jobs: FinishedJob[];
  scrapReasons: { id: number; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  if (jobs.length === 0) return null;

  function reset() {
    setOpen(null);
    setReason(null);
    setQty(1);
  }

  function submit(job: FinishedJob, reasonCodeId: number, quantity: number) {
    setMessage(null);
    start(async () => {
      const res = await scrapFinishedWork({
        commandId: crypto.randomUUID(),
        operationId: job.id,
        quantity,
        reasonCodeId,
      });
      if (!res.ok) {
        setMessage({ text: res.error, error: true });
        return;
      }
      reset();
      setMessage({
        text: res.result.reopened
          ? `Written off. ${job.name} is back on your list to do again.`
          : "Written off.",
        error: false,
      });
      router.refresh();
    });
  }

  return (
    <Panel className="p-5">
      <h2 className="text-sm font-semibold text-gray-950">Finished here today</h2>
      <p className="mt-0.5 text-sm text-gray-500">
        Found a mistake in one of these? Say so — it goes back on the list.
      </p>

      <ul className="mt-3 space-y-2">
        {jobs.map((job) => (
          <li key={job.id} className="rounded-lg bg-gray-50/60 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-gray-900">{job.name}</p>
                <p className="text-xs text-gray-500">
                  {job.itemName} ·{" "}
                  <Link href={`/orders/${job.orderId}`} className="underline">
                    {job.orderNumber}
                  </Link>{" "}
                  · {job.finishedAt}
                </p>
              </div>
              {job.writableOff > 0 ? (
                <Button
                  tone="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setOpen(open === job.id ? null : job.id);
                    setQty(1);
                    setReason(null);
                    setMessage(null);
                  }}
                >
                  Scrap it
                </Button>
              ) : (
                <span className="text-xs text-gray-400">
                  Already fitted — a supervisor has to take it back out
                </span>
              )}
            </div>

            {open === job.id && (
              <div className="mt-3 rounded-lg bg-danger-50 p-3 ring-1 ring-inset ring-danger-600/20">
                <p className="text-xs font-medium text-danger-700">
                  Writing off work this step already finished. What went wrong?
                </p>

                <label className="mt-2 block text-xs text-gray-600">
                  How many of {job.writableOff}
                  <input
                    type="number"
                    min={1}
                    max={job.writableOff}
                    value={qty}
                    onChange={(e) => setQty(Number(e.target.value))}
                    className="tnum mt-1 block min-h-11 w-24 rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-gray-300"
                  />
                </label>

                {job.fitted > 0 && (
                  <p className="mt-2 text-xs text-gray-600">
                    {job.fitted} of these are already fitted into the next assembly and
                    are not included — those have to come back out first.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {scrapReasons.map((r) => (
                    <Button
                      key={r.id}
                      tone={reason === r.id ? "danger" : "secondary"}
                      size="sm"
                      disabled={pending}
                      onClick={() => setReason(r.id)}
                    >
                      {r.label}
                    </Button>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    tone="danger"
                    size="sm"
                    disabled={pending || reason === null}
                    onClick={() =>
                      reason !== null &&
                      submit(job, reason, Math.max(1, Math.min(qty || 0, job.writableOff)))
                    }
                  >
                    Write it off
                  </Button>
                  <Button size="sm" disabled={pending} onClick={reset}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-3 text-sm ${message.error ? "text-danger-700" : "text-success-700"}`}
        >
          {message.text}
        </p>
      )}
    </Panel>
  );
}
