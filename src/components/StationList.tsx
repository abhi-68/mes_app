"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { pinTerminal } from "@/app/actions/terminal";

export type StationBlock = {
  id: number;
  name: string;
  line: string | null;
  running: number;
  waiting: number;
};

/**
 * The stations, as blocks. Press one and it opens.
 *
 * Pressing does two things in one go: records where this device is, which is what
 * the server checks when the operator later presses Start, and opens that
 * station's page. Doing only the second would give them a list of jobs they would
 * then be refused.
 */
export function StationList({ stations }: { stations: StationBlock[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function open(id: number) {
    if (pending) return;
    startTransition(async () => {
      await pinTerminal(id);
      router.push(`/my-station/${id}`);
    });
  }

  if (stations.length === 0) {
    return <p className="text-sm text-steel-500">No stations are set up yet.</p>;
  }

  const lines = new Map<string, StationBlock[]>();
  for (const s of stations) {
    const key = s.line ?? "";
    const list = lines.get(key);
    if (list) list.push(s);
    else lines.set(key, [s]);
  }
  const named = [...lines.keys()].some((k) => k !== "");

  return (
    <div className="space-y-5">
      {[...lines.entries()].map(([line, group]) => (
        <div key={line || "single"}>
          {named && line && (
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-steel-400">
              {line}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.map((s) => {
              const total = s.running + s.waiting;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={pending}
                  onClick={() => open(s.id)}
                  className="flex min-h-24 flex-col justify-between rounded-xl border border-steel-300 bg-white p-5 text-left transition-all hover:-translate-y-px hover:border-steel-400 hover:shadow-raised disabled:opacity-50"
                >
                  <span className="text-lg font-semibold text-steel-900">{s.name}</span>
                  <span className="mt-2 flex items-center gap-2">
                    {total === 0 ? (
                      <span className="text-sm text-steel-400">Nothing here</span>
                    ) : (
                      <>
                        <span className="tnum text-2xl font-semibold text-navy-900">{total}</span>
                        <span className="text-sm text-steel-500">
                          job{total === 1 ? "" : "s"}
                          {s.running > 0 ? ` · ${s.running} running` : ""}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
