"use client";

import { Fragment, useState, useTransition } from "react";
import { adjustTimeEntry } from "@/app/actions/tasks";
import { Button, formatDuration, formatWhen } from "@/components/ui";

export type TimesheetRow = {
  id: number;
  workerName: string;
  stepName: string;
  orderNumber: string;
  startedAt: string;
  endedAt: string | null;
  originalSeconds: number | null;
  effectiveSeconds: number | null;
  /** After sharing overlapping clock-ons. This is what the job is costed at. */
  chargedSeconds: number | null;
  /** 0 when nothing overlapped; otherwise how many steps were open at once. */
  sharedWith: number;
  adjustments: { by: string; reason: string; newSeconds: number; at: string }[];
};

export function TimesheetTable({
  rows,
  canAdjust,
}: {
  rows: TimesheetRow[];
  canAdjust: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            <th className="px-5 py-2.5 font-medium">Worker</th>
            <th className="px-5 py-2.5 font-medium">Step</th>
            <th className="px-5 py-2.5 font-medium">Started</th>
            <th className="px-5 py-2.5 text-right font-medium">On the clock</th>
            <th className="px-5 py-2.5 text-right font-medium">Charged to the job</th>
            {canAdjust && <th className="px-5 py-2.5" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => {
            const wasAdjusted = row.adjustments.length > 0;
            return (
              // Keyed here rather than on each row: a bare fragment inside a map
              // has no key, which React warns about on every render.
              <Fragment key={row.id}>
                <tr>
                  <td className="px-5 py-3 text-gray-900">{row.workerName}</td>
                  <td className="px-5 py-3">
                    <div className="text-gray-900">{row.stepName}</div>
                    <div className="text-xs text-gray-400 tnum">{row.orderNumber}</div>
                  </td>
                  <td className="px-5 py-3 text-gray-500">
                    {formatWhen(new Date(row.startedAt))}
                  </td>
                  <td
                    className={`px-5 py-3 text-right tabular-nums ${
                      wasAdjusted ? "text-gray-400 line-through" : "text-gray-900"
                    }`}
                  >
                    {formatDuration(row.originalSeconds)}
                  </td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums text-gray-900">
                    {formatDuration(row.chargedSeconds)}
                    {row.sharedWith > 1 && (
                      <div className="text-xs font-normal tabular-nums text-gray-400">
                        shared with {row.sharedWith - 1} other{" "}
                        {row.sharedWith - 1 === 1 ? "step" : "steps"}
                      </div>
                    )}
                  </td>
                  {canAdjust && (
                    <td className="px-5 py-3 text-right">
                      <Button
                        size="sm"
                        tone="ghost"
                        onClick={() => setEditing(editing === row.id ? null : row.id)}
                      >
                        Correct
                      </Button>
                    </td>
                  )}
                </tr>

                {wasAdjusted && (
                  <tr className="bg-gray-50">
                    <td />
                    <td colSpan={canAdjust ? 5 : 4} className="px-5 pb-3 text-xs text-gray-500">
                      {row.adjustments.map((a, i) => (
                        <div key={i}>
                          Corrected to {formatDuration(a.newSeconds)} by {a.by} —{" "}
                          {a.reason}
                        </div>
                      ))}
                    </td>
                  </tr>
                )}

                {editing === row.id && (
                  <tr className="bg-gray-50">
                    <td />
                    <td colSpan={canAdjust ? 5 : 4} className="px-5 py-3">
                      <AdjustForm
                        entryId={row.id}
                        currentMinutes={Math.round((row.effectiveSeconds ?? 0) / 60)}
                        onDone={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdjustForm({
  entryId,
  currentMinutes,
  onDone,
}: {
  entryId: number;
  currentMinutes: number;
  onDone: () => void;
}) {
  const [minutes, setMinutes] = useState(currentMinutes);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-gray-500">Minutes</span>
          <input
            type="number"
            min={0}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="mt-1 w-28 rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3 text-sm min-h-11 tabular-nums"
          />
        </label>
        <label className="block flex-1 min-w-48">
          <span className="text-xs text-gray-500">Reason for the correction</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. forgot to clock off at end of shift"
            className="mt-1 w-full rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3 text-sm min-h-11"
          />
        </label>
        <Button
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await adjustTimeEntry(entryId, minutes, reason);
              if (!res.ok) setError(res.error);
              else onDone();
            });
          }}
        >
          Save correction
        </Button>
        <Button tone="secondary" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger-700">{error}</p>}
    </div>
  );
}
