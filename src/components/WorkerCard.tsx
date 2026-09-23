"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTask, pauseTask, completeTask, blockTask, unblockTask, assignTask } from "@/app/actions/tasks";
import { scrapMaterialAtStep } from "@/app/actions/picking";
import { PickList } from "@/components/PickList";
import { Drawings } from "@/components/Drawings";
import type { PickLine } from "@/app/actions/picking";
import type { AttachmentSummary } from "@/lib/attachment-shared";
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
  /** What to do at this step, set when the order was raised. */
  instructions: string | null;
  running: boolean;
  /** Whether THIS person has a clock running on it, as opposed to somebody else. */
  mine: boolean;
  /** How many other jobs this person's clock is running on at the same time. */
  sharedWith: number;
  /** A supervisor put this person's name on it.  */
  yours: boolean;
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
  drawings: AttachmentSummary[];
  /** When this part has to be done for the unit to ship on time. Derived. */
  neededBy: Date | null;
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
  scrapReasons,
  people = [],
}: {
  job: WorkerJob;
  problems: ProblemCode[];
  scrapReasons: ProblemCode[];
  /** Who a supervisor can hand this to. Empty for a worker, who cannot hand work out. */
  people?: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [menu, setMenu] = useState<"none" | "stop" | "down" | "give" | "scrap">("none");
  const [error, setError] = useState<string | null>(null);
  const command = useRef<string | null>(null);

  const isDown = job.status === "BLOCKED";
  const held = job.blockers.filter((b) => b.label !== "Earlier step");
  // The server refuses a start with material still on the rack, so the button
  // must not offer one.
  const toCollect = job.pickLines.reduce((n, l) => n + l.outstanding, 0);
  // What is out on the bench, and so what there is to scrap.
  const onBench = job.pickLines.filter((l) => l.taken > 0);

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

  /** Ruined it. Everything on the bench is written off and the job stays open. */
  function scrapBench(reasonCodeId: number) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      for (const line of onBench) {
        const res = await scrapMaterialAtStep({
          commandId: crypto.randomUUID(),
          operationId: job.id,
          requirementId: line.requirementId,
          quantity: line.taken,
          reasonCodeId,
          batchNumber: null,
          note: null,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      setMenu("none");
      router.refresh();
    });
  }

  return (
    <Panel
      data-step-card={job.name}
      className={`p-6 ${isDown ? "ring-danger-600/30" : ""}`}
    >
      {/* Identity: the number is what is written on the job in the real world. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="tnum text-lg font-semibold text-gray-950">{job.jobNumber}</p>
        {job.yours && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-info-50 px-2 py-1 text-xs font-medium text-info-700 ring-1 ring-inset ring-info-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-info-500" aria-hidden />
            Yours
          </span>
        )}
        {job.running && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-success-50 px-2 py-1 text-xs font-medium text-success-700 ring-1 ring-inset ring-success-600/20">
            <span className="h-1.5 w-1.5 rounded-full bg-success-600" aria-hidden />
            Running
          </span>
        )}
        {isDown && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-danger-50 px-2 py-1 text-xs font-medium text-danger-700 ring-1 ring-inset ring-danger-600/20">
            <span className="h-1.5 w-1.5 rounded-full bg-danger-600" aria-hidden />
            Down
          </span>
        )}
      </div>
      <p className="mt-0.5 text-sm font-medium text-gray-950">{job.name}</p>
      <p className="text-sm text-gray-500">
        {job.itemName}{" "}
        <Link
          href={`/orders/${job.orderId}`}
          className="tnum text-gray-400 underline underline-offset-2 hover:text-primary-600"
        >
          {job.orderNumber}
        </Link>
      </p>

      {job.neededBy && (
        <p className="tnum mt-1 text-sm font-medium text-gray-700">
          Needed by{" "}
          {job.neededBy.toLocaleString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}

      {isDown && job.blockedNote && (
        <p className="mt-2 rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">
          {job.blockedNote}
        </p>
      )}

      {held.length > 0 && !isDown && (
        <div className="mt-2 rounded-lg bg-danger-50 px-3 py-2">
          <p className="text-sm text-danger-700">{held[0].detail}</p>

          {/* A line job: say how far the thing you are waiting on has got, so the
              answer to "should I wait here" is on the card. */}
          {held[0].waitingOn && held[0].waitingOn.total > 0 && (
            <div className="mt-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/orders/${held[0].waitingOn.orderId}`}
                  className="tnum inline-flex min-h-11 items-center text-sm font-medium text-danger-700 underline underline-offset-2"
                >
                  {held[0].waitingOn.orderNumber}
                </Link>
                <span className="tnum text-xs text-danger-700/80">
                  {held[0].waitingOn.done} of {held[0].waitingOn.total} steps
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/60">
                <div
                  className="h-full rounded-full bg-danger-600"
                  style={{
                    width: `${Math.round(
                      (held[0].waitingOn.done / held[0].waitingOn.total) * 100
                    )}%`,
                  }}
                />
              </div>
              {held[0].waitingOn.currentStep && (
                <p className="mt-1 text-xs text-danger-700/80">
                  now on “{held[0].waitingOn.currentStep}”
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* The spec for this operation, in the office's words. */}
      {job.instructions && (
        <p className="mt-3 rounded-md bg-gray-50 px-4 py-3 text-sm text-gray-700">
          {job.instructions}
        </p>
      )}

      {job.mine && job.sharedWith > 0 && (
        <p className="mt-3 rounded-md bg-warning-50 px-4 py-3 text-sm text-warning-800">
          Your time is being shared with {job.sharedWith} other{" "}
          {job.sharedWith === 1 ? "job" : "jobs"}. An hour here counts as{" "}
          {Math.round(60 / (job.sharedWith + 1))} minutes.
        </p>
      )}

      {/* What to fetch. The only reading on the card, and it is a list of parts. */}
      {job.pickLines.length > 0 && (
        <PickList operationId={job.id} lines={job.pickLines} scrapReasons={scrapReasons} />
      )}

      {job.drawings.length > 0 && (
        <Drawings
          files={job.drawings}
          canUpload={false}
          heading="What you are building"
          compact
        />
      )}

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
                <Big
                  tone="primary"
                  disabled={pending || held.length > 0 || toCollect > 0}
                  onClick={begin}
                >
                  Start
                </Big>
              )}
              {/* Two people on one job is a real thing on a long weld, and the
                  timesheet already splits the hours between them. Without this
                  the second person has no way to say they are on it. */}
              {job.running && !job.mine && (
                <Big tone="primary" disabled={pending || held.length > 0} onClick={begin}>
                  Clock on
                </Big>
              )}
              {job.running && job.mine && (
                <Big disabled={pending} onClick={() => setMenu("stop")}>
                  Stop
                </Big>
              )}
              <Big tone="warn" disabled={pending} onClick={() => setMenu("down")}>
                Down
              </Big>
              {onBench.length > 0 && scrapReasons.length > 0 && (
                <Big tone="warn" disabled={pending} onClick={() => setMenu("scrap")}>
                  Scrap
                </Big>
              )}
              {people.length > 0 && (
                <Big disabled={pending} onClick={() => setMenu("give")}>
                  Give to someone
                </Big>
              )}
            </>
          )}
        </div>
      )}

      {/* Stop asks which kind, so "finished" and "having lunch" are never confused. */}
      {menu === "stop" && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">Stopping because…</p>
          <div className="flex flex-wrap gap-2">
            <Big
              tone="primary"
              disabled={pending || toCollect > 0}
              onClick={() => act(() => completeTask(job.id))}
            >
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

      {menu === "scrap" && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">
            Scrapping {onBench.map((l) => `${l.taken} ${l.unit} ${l.itemName}`).join(", ")}. What
            went wrong?
          </p>
          <div className="flex flex-wrap gap-2">
            {scrapReasons.map((r) => (
              <Big key={r.id} tone="warn" disabled={pending} onClick={() => scrapBench(r.id)}>
                {r.label}
              </Big>
            ))}
            <Big disabled={pending} onClick={() => setMenu("none")}>
              Cancel
            </Big>
          </div>
        </div>
      )}

      {menu === "down" && (        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">What is wrong?</p>
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

      {/* Names, not a dropdown: whoever hands the job out is standing at the
          machine, and the list of who is on shift is short. */}
      {menu === "give" && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">Who is doing this?</p>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <Big
                key={p.id}
                disabled={pending}
                onClick={() => act(() => assignTask(job.id, p.id))}
              >
                {p.name}
              </Big>
            ))}
            <Big disabled={pending} onClick={() => act(() => assignTask(job.id, null))}>
              Nobody
            </Big>
            <Big disabled={pending} onClick={() => setMenu("none")}>
              Cancel
            </Big>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger-700">
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
    default: "bg-white text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
    primary: "bg-gray-900 text-white hover:bg-gray-800",
    warn: "bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-600/20 hover:bg-warning-50/70",
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      /* A heavier press than the desk buttons: this is confirmed by feel, through a glove. */
      className={`inline-flex min-h-14 items-center rounded-lg px-6 text-base font-medium transition-[background-color,transform] duration-100 ease-out active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
