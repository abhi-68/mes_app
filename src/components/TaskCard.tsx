"use client";

import Link from "next/link";
import { useState, useTransition, useEffect, useRef } from "react";
import {
  startTask,
  pauseTask,
  completeTask,
  blockTask,
  unblockTask,
  recordQuality,
} from "@/app/actions/tasks";
import { Button, StatusPill, formatMinutes } from "@/components/ui";
import { PickList } from "@/components/PickList";
import type { PickLine } from "@/app/actions/picking";

export type TaskCardData = {
  id: number;
  name: string;
  sequence: number;
  status: string;
  expectedMinutes: number | null;
  stationName: string | null;
  orderNumber: string;
  jobNumber: string | null;
  itemName: string;
  workOrderId: number;
  dueLabel: string;
  blockedNote: string | null;
  /** ISO string of the current user's open time entry, if they are clocked on. */
  openSince: string | null;
  loggedMinutes: number;
  /** Who this step has been given to, if anyone. Null means the station picks it up. */
  assignedToUserId: number | null;
  assignedToName: string | null;
  /** True when the person reading this card is the one it was given to. */
  assignedToMe: boolean;
  /**
   * How many steps this viewer has open at once. Above one, their clock time is
   * being shared, and they should be told now rather than in a report next month.
   */
  concurrentOpen: number;
  /**
   * Everything standing between this step and Start, in the words the worker needs.
   * Empty means ready. Computed by src/lib/dependencies.ts, enforced server-side too.
   */
  blockers: {
    kind: "SEQUENCE" | "DEPENDENCY" | "MATERIAL";
    label: string;
    detail: string;
    sourceOrderNumber?: string;
    sourceOperationId?: number;
  }[];
  /** Used only for sorting the queue by urgency. */
  dueAt: number;
  /** What still has to be fetched from stores for this step. */
  pickLines?: PickLine[];
};

export type ReasonOption = { id: number; label: string; category: string };
export type AssignableUser = { id: number; name: string; stationName: string | null };

export function TaskCard({
  task,
  reasonCodes,
  canReopen,
  assignableUsers,
}: {
  task: TaskCardData;
  reasonCodes: ReasonOption[];
  canReopen: boolean;
  /** Present only for supervisors and admins — nobody else may hand work out. */
  assignableUsers?: AssignableUser[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "block" | "quality" | "assign">(null);

  /**
   * Command ids, held per action and REUSED on retry.
   *
   * This is the point of replay protection: if the network drops after the server
   * committed but before the response arrived, the worker taps Start again and the
   * server must recognise it as the same action. Minting a fresh UUID per attempt
   * would make every retry a new, duplicate command.
   *
   * The id is cleared only after a success, so a later genuine re-do gets a new one.
   */
  const commandIds = useRef<Record<string, string>>({});
  const commandIdFor = (action: string) => {
    if (!commandIds.current[action]) {
      commandIds.current[action] =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${task.id}-${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    return commandIds.current[action];
  };

  const run = (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    opts: { clears?: string } = {}
  ) => {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        // Keep the command id: the retry must carry the same one.
        setError(res.error ?? "Something went wrong");
      } else {
        if (opts.clears) delete commandIds.current[opts.clears];
        setPanel(null);
      }
    });
  };

  const isBlocked = task.status === "BLOCKED";
  const isDone = task.status === "DONE";
  const clockedOn = task.openSince !== null;

  return (
    <div
      // Named so end-to-end runs can address a specific step without depending on
      // the card's styling, which has moved twice already.
      data-step-card={task.name}
      className={`rounded-xl border bg-white shadow-card ${
        isBlocked
          ? "border-blocked-solid/50"
          : task.assignedToMe
            ? // Work with your name on it should be findable at arm's length.
              "border-mine-solid/60 ring-1 ring-mine-solid/20"
            : "border-steel-200/80"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <p className="text-base font-semibold text-steel-900">{task.name}</p>
          <p className="mt-1 text-sm text-steel-500">
            {task.itemName}
            <span className="text-steel-300"> / </span>
            <Link href={`/orders/${task.workOrderId}`} className="tnum underline underline-offset-2 hover:text-navy-800">
              {task.orderNumber}
            </Link>
            <span className="text-steel-300"> / </span>
            {task.dueLabel}
          </p>
          <p className="mt-0.5 text-xs text-steel-400">
            {task.stationName ?? "Unassigned"}
            {task.expectedMinutes ? ` · ${formatMinutes(task.expectedMinutes)} estimated` : ""}
            {task.loggedMinutes > 0 ? ` · ${formatMinutes(task.loggedMinutes)} logged` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <StatusPill status={task.status} />
          {task.assignedToName && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                task.assignedToMe
                  ? "bg-mine-solid text-white"
                  : "bg-mine-bg text-mine-fg"
              }`}
            >
              {task.assignedToMe ? "Yours" : task.assignedToName}
            </span>
          )}
        </div>
      </div>

      {isBlocked && task.blockedNote && (
        <p className="mx-5 mt-3 rounded-md bg-blocked-bg px-3 py-2 text-sm text-blocked-fg">
          {task.blockedNote}
        </p>
      )}

      {task.blockers.length > 0 && !isDone && (
        <div className="mx-5 mt-3 space-y-1.5">
          {task.blockers.map((b, i) => (
            <div
              key={i}
              className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-3 py-2 text-sm ${
                b.kind === "SEQUENCE"
                  ? "bg-steel-100 text-steel-600"
                  : "bg-blocked-bg text-blocked-fg"
              }`}
            >
              <span className="rounded bg-white/70 px-1.5 py-0.5 text-xs font-medium">
                {b.label}
              </span>
              <span>{b.detail}</span>
            </div>
          ))}
        </div>
      )}

      {!isDone && task.pickLines && task.pickLines.length > 0 && (
        <PickList operationId={task.id} lines={task.pickLines} />
      )}

      {clockedOn && <RunningClock since={task.openSince!} />}

      {clockedOn && task.concurrentOpen > 1 && (
        <p className="mx-5 mt-2 rounded-md bg-steel-100 px-3 py-2 text-xs text-steel-600">
          You have {task.concurrentOpen} steps running at once, so this time is being shared
          between them — an hour on the clock counts as {formatMinutes(Math.round(60 / task.concurrentOpen))}{" "}
          against each. Clock off anything you are not actually on.
        </p>
      )}

      {error && (
        <p className="mx-5 mt-3 rounded-md bg-blocked-bg px-3 py-2 text-sm text-blocked-fg">
          {error}
        </p>
      )}

      {/* Primary actions — sized for gloved hands on a tablet */}
      <div className="flex flex-wrap gap-2 px-5 pb-4 pt-4">
        {!isDone && !isBlocked && !clockedOn && (
          <Button
            size="lg"
            /* Someone else already started this step, so joining it is clocking on,
               not starting. Same action either way; the label should not lie. */
            tone={task.status === "IN_PROGRESS" ? "secondary" : "primary"}
            onClick={() =>
              run(() => startTask(task.id, commandIdFor("start")), { clears: "start" })
            }
            disabled={pending || task.blockers.length > 0}
          >
            {task.status === "IN_PROGRESS" ? "Clock on" : "Start"}
          </Button>
        )}
        {!isDone && clockedOn && (
          <>
            <Button
              size="lg"
              onClick={() => run(() => completeTask(task.id))}
              disabled={pending}
              className="bg-ok-solid hover:brightness-95"
            >
              Mark done
            </Button>
            <Button
              size="lg"
              tone="secondary"
              onClick={() => run(() => pauseTask(task.id))}
              disabled={pending}
            >
              Clock off
            </Button>
          </>
        )}
        {!isDone && !clockedOn && task.status === "IN_PROGRESS" && (
          <Button
            size="lg"
            onClick={() => run(() => completeTask(task.id))}
            disabled={pending}
            className="bg-ok-solid hover:brightness-95"
          >
            Mark done
          </Button>
        )}
        {!isDone && !isBlocked && (
          <Button
            size="lg"
            tone="secondary"
            onClick={() => setPanel(panel === "block" ? null : "block")}
            disabled={pending}
          >
            Can&apos;t continue
          </Button>
        )}
        {isBlocked && (
          <Button size="lg" onClick={() => run(() => unblockTask(task.id))} disabled={pending}>
            Unblock
          </Button>
        )}
        {!isDone && (
          <Button
            size="lg"
            tone="ghost"
            onClick={() => setPanel(panel === "quality" ? null : "quality")}
            disabled={pending}
          >
            Log scrap or rework
          </Button>
        )}
        {isDone && canReopen && (
          <Button size="sm" tone="ghost" onClick={() => run(() => reopen(task.id))} disabled={pending}>
            Reopen
          </Button>
        )}
        {!isDone && assignableUsers && assignableUsers.length > 0 && (
          <Button
            size="lg"
            tone="ghost"
            onClick={() => setPanel(panel === "assign" ? null : "assign")}
            disabled={pending}
          >
            {task.assignedToName ? "Reassign" : "Give to someone"}
          </Button>
        )}
      </div>

      {panel === "block" && (
        <BlockPanel
          reasonCodes={reasonCodes.filter((r) => r.category === "BLOCKED")}
          pending={pending}
          onCancel={() => setPanel(null)}
          onSubmit={(reasonId, note) => run(() => blockTask(task.id, reasonId, note))}
        />
      )}

      {panel === "assign" && assignableUsers && (
        <AssignPanel
          users={assignableUsers}
          current={task.assignedToUserId}
          currentName={task.assignedToName}
          pending={pending}
          onCancel={() => setPanel(null)}
          onSubmit={(userId) => run(() => assign(task.id, userId))}
        />
      )}

      {panel === "quality" && (
        <QualityPanel
          reasonCodes={reasonCodes}
          pending={pending}
          onCancel={() => setPanel(null)}
          onSubmit={(type, qty, reasonId, notes) =>
            run(() => recordQuality(task.id, type, qty, reasonId, notes))
          }
        />
      )}
    </div>
  );
}

async function reopen(taskId: number) {
  const { reopenTask } = await import("@/app/actions/tasks");
  return reopenTask(taskId);
}

async function assign(taskId: number, userId: number | null) {
  const { assignTask } = await import("@/app/actions/tasks");
  return assignTask(taskId, userId);
}

function AssignPanel({
  users,
  current,
  currentName,
  pending,
  onCancel,
  onSubmit,
}: {
  users: AssignableUser[];
  current: number | null;
  currentName: string | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (userId: number | null) => void;
}) {
  const [userId, setUserId] = useState<number | null>(current);

  return (
    <div className="border-t border-steel-200 bg-steel-50 px-5 py-4">
      <p className="text-sm font-medium text-steel-700">Who should do this step?</p>
      <p className="mt-1 text-xs text-steel-500">
        Leaving it unassigned is normal — anyone at the station can pick it up. Naming someone
        puts it at the top of their screen and tells them.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block flex-1 min-w-52">
          <span className="text-xs text-steel-500">Assign to</span>
          <select
            value={userId ?? ""}
            onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11"
          >
            <option value="">Anyone at the station</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.stationName ? ` — ${u.stationName}` : ""}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={pending} onClick={() => onSubmit(userId)}>
          {userId === null ? "Leave it open" : "Give it to them"}
        </Button>
        <Button tone="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {currentName && (
        <p className="mt-2 text-xs text-steel-500">Currently with {currentName}.</p>
      )}
    </div>
  );
}

function RunningClock({ since }: { since: string }) {
  /*
   * The elapsed time differs between the server render and the client hydration —
   * they run at different instants — which produced a hydration mismatch. The clock
   * therefore renders a stable placeholder on the server and starts ticking only
   * once mounted on the client.
   */
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setElapsed(Date.now() - new Date(since).getTime());
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [since]);

  const total = elapsed === null ? 0 : Math.max(0, Math.floor(elapsed / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="mx-5 mt-3 flex items-center gap-2 rounded-md bg-active-bg px-3 py-2">
      <span className="h-2 w-2 rounded-full bg-active-solid" aria-hidden />
      <span className="text-sm text-active-fg">Clocked on</span>
      <span
        className="ml-auto text-lg font-semibold tabular-nums text-active-fg"
        suppressHydrationWarning
      >
        {elapsed === null ? "--:--" : `${h > 0 ? `${h}:` : ""}${pad(m)}:${pad(s)}`}
      </span>
    </div>
  );
}

function BlockPanel({
  reasonCodes,
  pending,
  onCancel,
  onSubmit,
}: {
  reasonCodes: ReasonOption[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reasonId: number | null, note: string) => void;
}) {
  const [reasonId, setReasonId] = useState<number | null>(reasonCodes[0]?.id ?? null);
  const [note, setNote] = useState("");

  return (
    <div className="border-t border-steel-200 bg-steel-50 px-5 py-4">
      <p className="text-sm font-medium text-steel-700">What is stopping this step?</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-steel-500">Reason</span>
          <select
            value={reasonId ?? ""}
            onChange={(e) => setReasonId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11"
          >
            {reasonCodes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-steel-500">Detail (what exactly is missing?)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. 60 ft of copper tube outstanding"
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11"
          />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button tone="danger" disabled={pending} onClick={() => onSubmit(reasonId, note)}>
          Flag as blocked
        </Button>
        <Button tone="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function QualityPanel({
  reasonCodes,
  pending,
  onCancel,
  onSubmit,
}: {
  reasonCodes: ReasonOption[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (
    type: "SCRAP" | "REWORK",
    qty: number,
    reasonId: number | null,
    notes: string
  ) => void;
}) {
  const [type, setType] = useState<"SCRAP" | "REWORK">("REWORK");
  const options = reasonCodes.filter((r) => r.category === type);
  const [reasonId, setReasonId] = useState<number | null>(options[0]?.id ?? null);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  return (
    <div className="border-t border-steel-200 bg-steel-50 px-5 py-4">
      <p className="text-sm font-medium text-steel-700">Record a quality problem</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="text-xs text-steel-500">Type</span>
          <select
            value={type}
            onChange={(e) => {
              const next = e.target.value as "SCRAP" | "REWORK";
              setType(next);
              setReasonId(reasonCodes.find((r) => r.category === next)?.id ?? null);
            }}
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11"
          >
            <option value="REWORK">Rework</option>
            <option value="SCRAP">Scrap</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-steel-500">Quantity</span>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11 tabular-nums"
          />
        </label>
        <label className="block">
          <span className="text-xs text-steel-500">Reason</span>
          <select
            value={reasonId ?? ""}
            onChange={(e) => setReasonId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11"
          >
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-steel-500">Note</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11"
          />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button disabled={pending} onClick={() => onSubmit(type, qty, reasonId, notes)}>
          Record
        </Button>
        <Button tone="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
