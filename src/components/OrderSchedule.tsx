import { Panel } from "@/components/ui";

/** Working minutes -> "2 days 3h". A day is a shift, not 24 hours. */
function formatWorkingSpan(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  const days = Math.floor(abs / 480);
  const hours = Math.floor((abs % 480) / 60);
  const mins = abs % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours}h`);
  if (parts.length === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

function formatDay(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type SubAssemblyDeadline = {
  workOrderId: number;
  name: string;
  neededBy: Date | null;
  done: boolean;
};

/**
 * Projected finish against the promised date, and the derived deadline for each
 * sub-assembly feeding it.
 *
 * The scheduler assumes every part is on the rack. When it is not, a finish date
 * is a guess dressed up as a plan, so it is withheld and the work content is
 * shown instead — that still answers "can we build this many in the time left".
 *
 * The caveats at the foot are not decoration. A schedule built on guessed
 * durations and an assumption of unlimited labour will be wrong, and a plan that
 * does not admit what it assumed gets believed until the day it fails.
 */
export function OrderSchedule({
  projectedFinish,
  dueDate,
  lateByMinutes,
  shortItems,
  workMinutes,
  minutesUntilDue,
  subAssemblies,
  guessedDurations,
  totalSteps,
  computedAt,
}: {
  projectedFinish: Date | null;
  dueDate: Date | null;
  lateByMinutes: number | null;
  /** How many purchased parts are not in stock. Non-zero suppresses the date. */
  shortItems: number;
  /** Working minutes of build left, however long the parts take to arrive. */
  workMinutes: number;
  minutesUntilDue: number | null;
  subAssemblies: SubAssemblyDeadline[];
  guessedDurations: number;
  totalSteps: number;
  computedAt: Date;
}) {
  if (!projectedFinish) return null;

  const late = lateByMinutes != null && lateByMinutes > 0;
  const waiting = shortItems > 0;
  const willNotFit = minutesUntilDue != null && workMinutes > minutesUntilDue;
  const outstanding = subAssemblies.filter((s) => !s.done && s.neededBy);

  return (
    <Panel className="mt-4 p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold leading-6 text-gray-950">Schedule</h2>
        <span className="text-xs text-gray-500">
          as of{" "}
          {computedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-4">
        <div>
          <p className="text-sm font-medium text-gray-500">
            {waiting ? "Work to do" : "Projected finish"}
          </p>
          <p className="tnum mt-0.5 text-lg font-semibold text-gray-950">
            {waiting ? formatWorkingSpan(workMinutes) : formatDay(projectedFinish)}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-500">Due</p>
          <p className="tnum mt-0.5 text-lg font-semibold text-gray-950">
            {dueDate ? formatDay(dueDate) : "No date promised"}
          </p>
        </div>
      </div>

      {waiting ? (
        <div
          className={`mt-4 rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset ${
            willNotFit
              ? "bg-danger-50 text-danger-700 ring-danger-600/20"
              : "bg-warning-50 text-warning-800 ring-warning-600/20"
          }`}
        >
          {minutesUntilDue == null
            ? "No finish date until the short parts arrive."
            : willNotFit
              ? `Will not fit — ${formatWorkingSpan(workMinutes)} of work, ${formatWorkingSpan(minutesUntilDue)} left before it is due, and the parts are not here yet.`
              : `No finish date until the short parts arrive. ${formatWorkingSpan(minutesUntilDue)} of working time left before it is due.`}
        </div>
      ) : (
        lateByMinutes != null && (
          <div
            className={`mt-4 rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset ${
              late
                ? "bg-danger-50 text-danger-700 ring-danger-600/20"
                : "bg-success-50 text-success-700 ring-success-600/20"
            }`}
          >
            {late
              ? `Late by ${formatWorkingSpan(lateByMinutes)} of working time`
              : `On time — ${formatWorkingSpan(lateByMinutes)} spare`}
          </div>
        )
      )}

      {outstanding.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium text-gray-500">
            Needed by{" "}
            <span className="font-normal text-gray-400">
              — derived from the unit&rsquo;s due date, not entered by hand
            </span>
          </p>
          <ul className="mt-2 divide-y divide-gray-200">
            {outstanding.map((s) => (
              <li
                key={s.workOrderId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm"
              >
                <span className="font-medium text-gray-950">{s.name}</span>
                <span className="tnum text-gray-500">{formatDay(s.neededBy!)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-6 border-t border-gray-200 pt-3 text-xs leading-relaxed text-gray-500">
        Machine capacity is honoured. <strong className="font-medium">Labour is not</strong> —
        one person per job, always available.
        {guessedDurations > 0 && (
          <>
            {" "}
            <span className="tnum">{guessedDurations}</span> of{" "}
            <span className="tnum">{totalSteps}</span> steps carry no time estimate and were
            scheduled at 60 minutes.
          </>
        )}{" "}
        Dates move if the priority rule changes.
      </p>
    </Panel>
  );
}
