"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { endShift } from "@/app/actions/shift";
import type { ShiftSummary } from "@/lib/shift";
import { Panel } from "@/components/ui";

/** End of shift, then the numbers. Two presses, because it stops live work. */
export function EndShift({ name }: { name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function finish() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await endShift();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSummary(res.summary);
      setConfirming(false);
      router.refresh();
    });
  }

  if (summary) {
    const tiles: [string, number][] = [
      ["Jobs done", summary.jobsDone],
      ["Started", summary.jobsStarted],
      ["Made", summary.unitsProduced],
      ["Rework", summary.reworked],
      ["Rejected", summary.rejected],
      ["Times down", summary.timesDown],
    ];
    return (
      <Panel className="px-5 py-5">
        <p className="text-lg font-semibold text-gray-950">{name} — today</p>
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
          {tiles.map(([label, value]) => (
            <div key={label} className="rounded-lg bg-gray-50 px-3 py-3 text-center">
              <p className="tnum text-2xl font-semibold text-gray-950">{value}</p>
              <p className="mt-0.5 text-xs text-gray-500">{label}</p>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSummary(null)}
          className="mt-4 inline-flex min-h-11 items-center rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-4 text-sm text-gray-600"
        >
          Close
        </button>
      </Panel>
    );
  }

  return (
    <Panel className="px-5 py-4">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-700">Stop everything and finish for today?</p>
          <button
            type="button"
            disabled={pending}
            onClick={finish}
            className="inline-flex min-h-12 items-center rounded-lg bg-gray-900 px-5 text-base font-medium text-white disabled:opacity-50"
          >
            {pending ? "Finishing…" : "Yes, end shift"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            className="inline-flex min-h-12 items-center rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-5 text-base text-gray-700"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex min-h-12 items-center rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-5 text-base font-medium text-gray-700 hover:bg-gray-50"
        >
          End shift
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {error}
        </p>
      )}
    </Panel>
  );
}
