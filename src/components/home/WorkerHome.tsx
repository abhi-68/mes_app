import Link from "next/link";
import type { WorkerHome, WorkerStep } from "@/lib/home";
import type { Alert } from "@/lib/alerts";
import type { SessionUser } from "@/lib/session";
import {
  PageHeader,
  Panel,
  SectionHeading,
  EmptyState,
  LinkButton,
  Chip,
  formatMinutes,
  formatRelativeDue,
} from "@/components/ui";

/**
 * A worker's home screen answers one question: what do I do next?
 *
 * Everything on it is either the answer or the reason there isn't one. The
 * ordering is not cosmetic — it is the order a person on the floor actually
 * needs: what I am on now, what I was told to do, what I can pick up, and only
 * then what is stuck and why. No charts, no plant totals, nothing that requires
 * reading before it can be understood.
 *
 * Actions live on the step cards at My work rather than here, so that there is
 * exactly one screen where work is started and stopped. Two places to tap Start
 * is how a step ends up begun twice.
 */
export function WorkerHomeScreen({
  data,
  user,
  alerts,
}: {
  data: WorkerHome;
  user: SessionUser;
  alerts: Alert[];
}) {
  const firstName = user.name.split(" ")[0];
  const sharing = data.running.length > 1;
  const handed = alerts.filter((a) => a.kind === "ASSIGNED_TO_YOU");
  const goodNews = alerts.filter((a) => a.severity === "good");

  const nothingAtAll =
    data.running.length === 0 &&
    data.mine.length === 0 &&
    data.ready.length === 0 &&
    data.waiting.length === 0 &&
    data.blockedHere.length === 0;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow={data.stationName ?? "No station set"}
        title={`Hello, ${firstName}`}
        /* Kept: not knowing you have no station is the one thing worth saying here. */
        subtitle={data.stationName ? undefined : "Ask an admin to put you on a station."}
      />

      {/* --- what I am on right now ------------------------------------- */}
      {data.running.length > 0 && (
        <section className="mt-7">
          <SectionHeading note={sharing ? "Your time is split between these" : "Clock running"}>
            You are on {data.running.length === 1 ? "this" : `these ${data.running.length}`}
          </SectionHeading>
          <div className="space-y-3">
            {data.running.map((s) => (
              <StepRow key={s.id} step={s} tone="running" />
            ))}
          </div>
          {sharing && (
            <p className="mt-2 text-xs text-gray-500">
              An hour counts as {formatMinutes(Math.round(60 / data.running.length))} against
              each.
            </p>
          )}
          <div className="mt-3">
            <LinkButton href="/my-station" tone="primary" size="lg">
              Open my work
            </LinkButton>
          </div>
        </section>
      )}

      {/* --- what I was told to do --------------------------------------- */}
      {data.mine.length > 0 && (
        <section className="mt-8">
          <SectionHeading note={`${handed.length > 0 ? "New" : "Given to you by name"}`}>
            Yours to do next
          </SectionHeading>
          <div className="space-y-3">
            {data.mine.map((s) => (
              <StepRow key={s.id} step={s} tone="mine" />
            ))}
          </div>
          {data.running.length === 0 && (
            <div className="mt-3">
              <LinkButton href="/my-station" tone="primary" size="lg">
                Start the next one
              </LinkButton>
            </div>
          )}
        </section>
      )}

      {/* --- what I can pick up ------------------------------------------ */}
      {data.ready.length > 0 && (
        <section className="mt-8">
          <SectionHeading>
            Ready at {data.stationName ?? "your station"}
          </SectionHeading>
          <div className="space-y-3">
            {data.ready.slice(0, 5).map((s) => (
              <StepRow key={s.id} step={s} tone="ready" />
            ))}
          </div>
          {data.ready.length > 5 && (
            <p className="mt-2 text-xs text-gray-400">
              and {data.ready.length - 5} more on{" "}
              <Link href="/my-station" className="underline">
                My work
              </Link>
              .
            </p>
          )}
          {data.running.length === 0 && data.mine.length === 0 && (
            <div className="mt-3">
              <LinkButton href="/my-station" tone="primary" size="lg">
                Pick one up
              </LinkButton>
            </div>
          )}
        </section>
      )}

      {/* --- good news --------------------------------------------------- */}
      {goodNews.length > 0 && (
        <section className="mt-8">
          <SectionHeading>
            You can get on with {goodNews.length === 1 ? "this" : "these"}
          </SectionHeading>
          <Panel className="divide-y divide-gray-100 overflow-hidden border-l-2 border-l-success-600">
            {goodNews.slice(0, 4).map((a) => (
              <div key={a.key} className="px-5 py-3.5">
                <p className="text-sm font-medium text-gray-900">{a.title}</p>
                {a.detail && <p className="mt-0.5 text-xs text-gray-500">{a.detail}</p>}
              </div>
            ))}
          </Panel>
        </section>
      )}

      {/* --- what is stuck, and why -------------------------------------- */}
      {(data.blockedHere.length > 0 || data.waiting.length > 0) && (
        <section className="mt-8">
          <SectionHeading>
            Not ready
          </SectionHeading>
          <Panel className="divide-y divide-gray-100 overflow-hidden">
            {data.blockedHere.map((s) => (
              <div key={s.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Chip tone="alert">Flagged</Chip>
                  <p className="text-sm font-medium text-gray-900">{s.name}</p>
                  <span className="tnum text-xs text-gray-400">{s.orderNumber}</span>
                </div>
                <p className="mt-1 text-xs text-danger-700">
                  {s.blockers[0]?.detail ?? "A supervisor has been told."}
                </p>
              </div>
            ))}
            {data.waiting.slice(0, 6).map((s) => (
              <div key={s.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Chip tone="quiet">{s.blockers[0]?.label ?? "Waiting"}</Chip>
                  <p className="text-sm font-medium text-gray-900">{s.name}</p>
                  <span className="tnum text-xs text-gray-400">{s.orderNumber}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {s.blockers[0]?.detail ?? "Waiting its turn."}
                </p>
              </div>
            ))}
          </Panel>
        </section>
      )}

      {nothingAtAll && (
        <div className="mt-7">
          <EmptyState
            title="Nothing waiting for you"
            hint={
              data.stationName
                ? `No steps are queued at ${data.stationName} right now. They appear here the moment one is released.`
                : "Once an admin puts you on a station, your work appears here."
            }
          />
        </div>
      )}

      <div className="mt-9 flex flex-wrap gap-2">
        <Link
          href="/my-station"
          className="inline-flex min-h-9 items-center rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          My work
        </Link>
        <Link
          href="/orders"
          className="inline-flex min-h-9 items-center rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          All orders
        </Link>
      </div>
    </div>
  );
}

function StepRow({ step, tone }: { step: WorkerStep; tone: "running" | "mine" | "ready" }) {
  const border =
    tone === "running"
      ? "border-l-warning-500"
      : tone === "mine"
        ? "border-l-info-600"
        : "border-l-gray-300";

  return (
    <Panel interactive className={`overflow-hidden border-l-2 ${border}`}>
      <Link
        href="/my-station"
        className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4"
      >
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-gray-900">{step.name}</p>
          <p className="mt-0.5 text-sm text-gray-500">
            {step.itemName}
            <span className="text-gray-300"> / </span>
            <span className="tnum">{step.orderNumber}</span>
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {formatRelativeDue(step.dueDate)}
            {step.expectedMinutes ? ` · ${formatMinutes(step.expectedMinutes)} estimated` : ""}
            {step.stationName ? ` · ${step.stationName}` : ""}
          </p>
        </div>
        {tone === "running" && (
          <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-warning-700">
            <span className="h-2 w-2 rounded-full bg-warning-500" aria-hidden />
            Clocked on
          </span>
        )}
        {tone === "mine" && (
          <span className="shrink-0 rounded-full bg-info-600 px-2 py-0.5 text-xs font-medium text-white">
            Yours
          </span>
        )}
      </Link>
    </Panel>
  );
}
