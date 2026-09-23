import Link from "next/link";
import { getCurrentUser, isManager } from "@/lib/session";
import { alertsFor, LATE_MULTIPLIER, type Alert } from "@/lib/alerts";
import { AcknowledgeButton } from "@/components/AcknowledgeButton";
import { PageHeader, Panel, SectionHeading, EmptyState, Stat, Chip } from "@/components/ui";

const KIND_LABEL: Record<Alert["kind"], string> = {
  STEP_READY: "Ready to start",
  STEP_BLOCKED: "Blocked",
  ASSIGNED_TO_YOU: "Given to you",
  MATERIAL_SHORT: "Material short",
  RUNNING_LATE: "Running long",
  ORDER_AT_RISK: "Order at risk",
  BELOW_REORDER: "Reorder",
};

export default async function AlertsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const all = await alertsFor(user);
  const manager = isManager(user.role);

  const good = all.filter((a) => a.severity === "good");
  const attention = all.filter((a) => a.severity === "attention");
  // Work handed to you by name is neither good news nor a problem — it is an
  // instruction, and it goes above both because it is the only one addressed to
  // you personally.
  const info = all.filter((a) => a.severity === "info");

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Alerts"
        title={manager ? "Needs someone" : "Your alerts"}
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Needs attention"
          value={attention.length}
          tone={attention.length ? "alert" : "default"}
          note={attention.length ? "Blocked, short or overrunning" : "Nothing outstanding"}
        />
        <Stat
          label="Good news"
          value={good.length}
          note="Work that can now begin"
        />
        <Stat
          label="Late after"
          value={`${LATE_MULTIPLIER}×`}
          tone="muted"
          note="The estimate on the step"
        />
      </div>

      {all.length === 0 && (
        <div className="mt-8">
          <EmptyState
            title="Nothing to tell you"

          />
        </div>
      )}

      {info.length > 0 && (
        <section className="mt-8">
          <SectionHeading>
            Handed to you
          </SectionHeading>
          <div className="space-y-2.5">
            {info.map((a) => (
              <AlertRow key={a.key} alert={a} />
            ))}
          </div>
        </section>
      )}

      {good.length > 0 && (
        <section className="mt-8">
          <SectionHeading>You can start</SectionHeading>
          <div className="space-y-2.5">
            {good.map((a) => (
              <AlertRow key={a.key} alert={a} />
            ))}
          </div>
        </section>
      )}

      {attention.length > 0 && (
        <section className="mt-8">
          <SectionHeading
            note={undefined}
          >
            Needs attention
          </SectionHeading>
          <div className="space-y-2.5">
            {attention.map((a) => (
              <AlertRow key={a.key} alert={a} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const good = alert.severity === "good";
  const mine = alert.severity === "info";
  return (
    <Panel
      className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-3 overflow-hidden border-l-2 px-5 py-4 ${
        mine ? "border-l-info-600" : good ? "border-l-success-600" : "border-l-danger-600"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Chip tone={good || mine ? "quiet" : "alert"}>{KIND_LABEL[alert.kind]}</Chip>
          <p className="text-[0.9375rem] font-medium text-gray-900">{alert.title}</p>
        </div>
        {alert.detail && (
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{alert.detail}</p>
        )}
        <p className="mt-1.5 text-xs text-gray-400">
          {alert.stationName ?? "No station"}
          {alert.orderNumber && (
            <>
              <span className="text-gray-300"> · </span>
              <Link href={`/orders/${alert.workOrderId}`} className="tnum underline underline-offset-2 hover:text-primary-600">
                {alert.orderNumber}
              </Link>
            </>
          )}
          <span className="text-gray-300"> · </span>
          {timeAgo(alert.at)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {alert.workOrderId && (
          <Link
            href={`/orders/${alert.workOrderId}`}
            className="inline-flex min-h-11 items-center rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-4 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:border-gray-400 hover:bg-gray-50"
          >
            Open unit
          </Link>
        )}
        {alert.acknowledgeable && alert.id !== null ? (
          <AcknowledgeButton alertId={alert.id} />
        ) : (
          <span className="text-xs text-gray-400">Clears itself</span>
        )}
      </div>
    </Panel>
  );
}

function timeAgo(at: Date): string {
  const mins = Math.round((Date.now() - at.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
