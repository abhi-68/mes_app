import Link from "next/link";
import type { SupervisorHome } from "@/lib/home";
import type { SessionUser } from "@/lib/session";
import {
  PageHeader,
  Panel,
  SectionHeading,
  EmptyState,
  Stat,
  Chip,
  LinkButton,
  formatMinutes,
} from "@/components/ui";

/**
 * A supervisor's home screen answers a different question: what is stuck, and
 * who is free to deal with it?
 *
 * The ordering is by how much it is costing. A blocked step has already stopped
 * work — it is first, and it is sorted oldest first, because an hour-old blocker
 * that nobody has touched is worse than one raised a minute ago. Overruns come
 * next because they are work happening badly rather than not at all. Station
 * workload comes last because it is the answer to "who do I give it to", which
 * is the second question, never the first.
 */
export function SupervisorHomeScreen({
  data,
  user,
  alertCount,
}: {
  data: SupervisorHome;
  user: SessionUser;
  alertCount: number;
}) {
  const firstName = user.name.split(" ")[0];
  const quiet = data.blocked.length === 0 && data.overdue.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Supervisor"
        title={`Hello, ${firstName}`}
        subtitle={
          quiet
            ? "Nothing is blocked and nothing is overrunning. Below is where the work is sitting."
            : "Everything that has stopped or is running long, worst first. Open one to clear it."
        }
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-4">
        <Stat
          label="Blocked"
          value={data.blocked.length}
          tone={data.blocked.length ? "alert" : "default"}
          note={data.blocked.length ? "Work has stopped" : "Nothing stopped"}
        />
        <Stat
          label="Running long"
          value={data.overdue.length}
          tone={data.overdue.length ? "alert" : "default"}
          note="Past twice the estimate"
        />
        <Stat
          label="Nobody assigned"
          value={data.needsSomeone}
          tone="muted"
          note="Waiting for anyone to pick up"
        />
        <Stat label="Units in build" value={data.openUnits} note="Not yet finished" />
      </div>

      {/* --- blocked ------------------------------------------------------ */}
      <section className="mt-8">
        <SectionHeading
          note={data.blocked.length > 0 ? "Oldest first — nobody else will clear these" : undefined}
        >
          Blocked right now
        </SectionHeading>
        {data.blocked.length === 0 ? (
          <EmptyState
            title="Nothing is blocked"
            hint="A step flagged on the floor appears here immediately, with who raised it and why."
          />
        ) : (
          <Panel className="divide-y divide-steel-100 overflow-hidden border-l-2 border-l-blocked-solid">
            {data.blocked.map((b) => (
              <div
                key={b.id}
                className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    {b.reason && <Chip tone="alert">{b.reason}</Chip>}
                    <p className="text-[0.9375rem] font-medium text-steel-900">{b.name}</p>
                  </div>
                  {b.note && <p className="mt-1 text-sm text-blocked-fg">{b.note}</p>}
                  <p className="mt-1 text-xs text-steel-400">
                    <Link href={`/orders/${b.workOrderId}`} className="tnum underline underline-offset-2 hover:text-navy-800">
                      {b.orderNumber}
                    </Link>
                    <span className="text-steel-300"> · </span>
                    {b.itemName}
                    {b.stationName && (
                      <>
                        <span className="text-steel-300"> · </span>
                        {b.stationName}
                      </>
                    )}
                    {b.raisedBy && (
                      <>
                        <span className="text-steel-300"> · </span>
                        raised by {b.raisedBy}
                      </>
                    )}
                    {b.ageMinutes !== null && (
                      <>
                        <span className="text-steel-300"> · </span>
                        <span
                          className={b.ageMinutes > 60 ? "font-medium text-blocked-fg" : ""}
                        >
                          {b.ageMinutes < 1
                            ? "just flagged"
                            : `stopped ${formatMinutes(b.ageMinutes)} ago`}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <LinkButton href={`/orders/${b.workOrderId}`}>
                    Open unit
                  </LinkButton>
                  <LinkButton href="/my-station" tone="primary">
                    Clear it
                  </LinkButton>
                </div>
              </div>
            ))}
          </Panel>
        )}
      </section>

      {/* --- overrunning --------------------------------------------------- */}
      {data.overdue.length > 0 && (
        <section className="mt-8">
          <SectionHeading note="Still running, past twice the estimate">
            Taking much longer than expected
          </SectionHeading>
          <Panel className="divide-y divide-steel-100 overflow-hidden">
            {data.overdue.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-steel-900">{o.name}</p>
                  <p className="mt-0.5 text-xs text-steel-400">
                    <Link href={`/orders/${o.workOrderId}`} className="tnum underline underline-offset-2 hover:text-navy-800">
                      {o.orderNumber}
                    </Link>
                    <span className="text-steel-300"> · </span>
                    {o.itemName}
                    {o.who && (
                      <>
                        <span className="text-steel-300"> · </span>
                        {o.who} is on it
                      </>
                    )}
                    {o.stationName && (
                      <>
                        <span className="text-steel-300"> · </span>
                        {o.stationName}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <p className="tnum text-right text-sm">
                    <span className="font-semibold text-blocked-fg">
                      {formatMinutes(o.elapsedMinutes)}
                    </span>
                    <span className="text-steel-400">
                      {" "}
                      / {formatMinutes(o.expectedMinutes ?? 0)}
                    </span>
                  </p>
                  <LinkButton href={`/orders/${o.workOrderId}`}>
                    Open
                  </LinkButton>
                </div>
              </div>
            ))}
          </Panel>
          <p className="mt-2 text-xs text-steel-400">
            A step that has genuinely taken longer is worth correcting on the timesheet rather
            than leaving to skew the estimates — the original is kept either way.
          </p>
        </section>
      )}

      {/* --- station workload ---------------------------------------------- */}
      <section className="mt-8">
        <SectionHeading note="Where the open work is sitting, and who is on shift">
          Station workload
        </SectionHeading>
        {data.load.length === 0 ? (
          <EmptyState title="No stations set up yet" hint="An admin creates these in Setup." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.load.map((s) => (
              <Panel key={s.stationName} className="px-5 py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[0.9375rem] font-medium text-steel-900">{s.stationName}</p>
                  <p className="text-sm text-steel-500">
                    <span className="tnum">{s.open}</span> open step{s.open === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-steel-500">
                  <span>
                    <span className="tnum">{s.peopleOnShift}</span>{" "}
                    {s.peopleOnShift === 1 ? "person" : "people"} clocked on
                  </span>
                  <span>
                    <span className="tnum">{s.running}</span> running
                  </span>
                  {s.blocked > 0 && (
                    <span className="font-medium text-blocked-fg">
                      <span className="tnum">{s.blocked}</span> blocked
                    </span>
                  )}
                  {s.unassigned > 0 && (
                    <span>
                      <span className="tnum">{s.unassigned}</span> nobody assigned
                    </span>
                  )}
                </div>
                {s.open > 0 && s.peopleOnShift === 0 && (
                  <p className="mt-2 text-xs text-steel-400">
                    Work waiting and nobody clocked on here.
                  </p>
                )}
              </Panel>
            ))}
          </div>
        )}
      </section>

      <Panel className="mt-9 px-5 py-4">
        <p className="text-sm text-steel-500">
          To hand a specific step to a specific person, open{" "}
          <Link href="/my-station" className="font-medium text-navy-700 underline">
            All stations
          </Link>{" "}
          and use <span className="font-medium text-steel-700">Give to someone</span> on the card.
          They are told, and it goes to the top of their screen.
          {alertCount > 0 && (
            <>
              {" "}
              There {alertCount === 1 ? "is" : "are"} {alertCount} thing
              {alertCount === 1 ? "" : "s"} in{" "}
              <Link href="/alerts" className="font-medium text-navy-700 underline">
                Alerts
              </Link>
              .
            </>
          )}
        </p>
      </Panel>
    </div>
  );
}
