"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTask, pauseTask, completeTask, blockTask, unblockTask } from "@/app/actions/tasks";
import { PickList } from "@/components/PickList";
import type { PickLine } from "@/app/actions/picking";
import { Panel } from "@/components/ui";

export type WorkerJob = {
  id: number;
  name: string;
  /** What the job is called on the floor: order number and station, ORD-0001-20. */
  jobNumber: string;
  orderId: number;
  orderNumber: string;
  itemName: string;
  status: string;
  running: boolean;
  blockedNote: string | null;
  blockers: {
    label: string;
    detail: string;
    /** For a line job: how far the work being waited on has got. */
    waitingOn?: {
      orderId: number;
      orderNumber: string;
      done: number;
      total: number;
      currentStep: string | null;
    } | null;
  }[];
  pickLines: PickLine[];
};

export type ProblemCode = { id: number; label: string };

/**
 * One job, as a worker sees it.
 *
 * Three buttons and nothing else: begin it, stop it, or say it is down. No clocks,
 * no durations, no audit trail on screen — all of that is still recorded, it just
 * is not the operator's problem. Anything that needs reading rather than pressing
 * has been taken off this card.
 *
 * Stop and Down both ask a second question rather than acting on the first press,
 * so a mis-tap costs a Cancel instead of a wrong record.
 */
export function WorkerCard({
  job,
  problems,
}: {
  job: WorkerJob;
  problems: ProblemCode[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [menu, setMenu] = useState<"none" | "stop" | "down">("none");
  const [error, setError] = useState<string | null>(null);
  const command = useRef<string | null>(null);

  const isDown = job.status === "BLOCKED";
  const held = job.blockers.filter((b) => b.label !== "Earlier step");

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "That did not work.");
      else {
        setMenu("none");
        command.current = null;
        router.refresh();
      }
    });
  }

  const begin = () => {
    const id = command.current ?? crypto.randomUUID();
    command.current = id;
    act(() => startTask(job.id, id));
  };

  return (
    <Panel className={`px-5 py-4 ${isDown ? "border-blocked-solid/50" : ""}`}>
      {/* Identity: the number is what is written on the job in the real world. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="tnum text-lg font-semibold text-navy-900">{job.jobNumber}</p>
        {job.running && <span className="text-sm font-medium text-ok-fg">Running</span>}
        {isDown && <span className="text-sm font-medium text-blocked-fg">Down</span>}
      </div>
      <p className="mt-0.5 text-[0.9375rem] text-steel-900">{job.name}</p>
      <p className="text-sm text-steel-500">
        {job.itemName}{" "}
        <Link
          href={`/orders/${job.orderId}`}
          className="tnum text-steel-400 underline underline-offset-2 hover:text-navy-800"
        >
          {job.orderNumber}
        </Link>
      </p>

      {isDown && job.blockedNote && (
        <p className="mt-2 rounded-md bg-blocked-bg px-3 py-2 text-sm text-blocked-fg">
          {job.blockedNote}
        </p>
      )}

      {held.length > 0 && !isDown && (
        <div className="mt-2 rounded-md bg-blocked-bg px-3 py-2">
          <p className="text-sm text-blocked-fg">{held[0].detail}</p>

          {/* A line job: say how far the thing you are waiting on has got, so the
              answer to "should I wait here" is on the card. */}
          {held[0].waitingOn && held[0].waitingOn.total > 0 && (
            <div className="mt-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/orders/${held[0].waitingOn.orderId}`}
                  className="tnum inline-flex min-h-11 items-center text-sm font-medium text-blocked-fg underline underline-offset-2"
                >
                  {held[0].waitingOn.orderNumber}
                </Link>
                <span className="tnum text-xs text-blocked-fg/80">
                  {held[0].waitingOn.done} of {held[0].waitingOn.total} steps
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/60">
                <div
                  className="h-full rounded-full bg-blocked-solid"
                  style={{
                    width: `${Math.round(
                      (held[0].waitingOn.done / held[0].waitingOn.total) * 100
                    )}%`,
                  }}
                />
              </div>
              {held[0].waitingOn.currentStep && (
                <p className="mt-1 text-xs text-blocked-fg/80">
                  now on “{held[0].waitingOn.currentStep}”
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* What to fetch. The only reading on the card, and it is a list of parts. */}
      {job.pickLines.length > 0 && <PickList operationId={job.id} lines={job.pickLines} />}

      {/* --- Buttons --- */}
      {menu === "none" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {isDown ? (
            <Big tone="primary" disabled={pending} onClick={() => act(() => unblockTask(job.id))}>
              Back up
            </Big>
          ) : (
            <>
              {!job.running && (
                <Big tone="primary" disabled={pending || held.length > 0} onClick={begin}>
                  Start
                </Big>
              )}
              {job.running && (
                <Big disabled={pending} onClick={() => setMenu("stop")}>
                  Stop
                </Big>
              )}
              <Big tone="warn" disabled={pending} onClick={() => setMenu("down")}>
                Down
              </Big>
            </>
          )}
        </div>
      )}

      {/* Stop asks which kind, so "finished" and "having lunch" are never confused. */}
      {menu === "stop" && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-steel-600">Stopping because…</p>
          <div className="flex flex-wrap gap-2">
            <Big tone="primary" disabled={pending} onClick={() => act(() => completeTask(job.id))}>
              Job done
            </Big>
            <Big disabled={pending} onClick={() => act(() => pauseTask(job.id))}>
              Break
            </Big>
            <Big disabled={pending} onClick={() => setMenu("none")}>
              Cancel
            </Big>
          </div>
        </div>
      )}

      {menu === "down" && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-steel-600">What is wrong?</p>
          <div className="flex flex-wrap gap-2">
            {problems.map((p) => (
              <Big
                key={p.id}
                tone="warn"
                disabled={pending}
                onClick={() => act(() => blockTask(job.id, p.id, p.label))}
              >
                {p.label}
              </Big>
            ))}
            <Big disabled={pending} onClick={() => setMenu("none")}>
              Cancel
            </Big>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-blocked-fg">
          {error}
        </p>
      )}
    </Panel>
  );
}

/** A button sized for a gloved hand. */
function Big({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "warn";
}) {
  const tones = {
    default: "border border-steel-300 bg-white text-steel-700 hover:bg-steel-50",
    primary: "bg-navy-800 text-white hover:bg-navy-900",
    warn: "bg-active-bg text-active-fg hover:bg-active-bg/70",
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-14 items-center rounded-lg px-6 text-base font-medium transition-colors disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
