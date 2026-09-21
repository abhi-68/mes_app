import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { floorMap, type FloorJob } from "@/lib/floor";
import { PageHeader, Panel, Stat, Chip, EmptyState, formatRelativeDue } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Everything at one station. Reached by tapping it on the map. */
export default async function StationPage(props: PageProps<"/floor/[id]">) {
  await requireUser();
  const { id } = await props.params;
  const stationId = Number(id);
  if (!Number.isSafeInteger(stationId)) notFound();

  const { stations } = await floorMap();
  const station = stations.find((s) => s.id === stationId);
  if (!station) notFound();

  const held = station.jobs.filter((j) => j.heldUp || j.status === "BLOCKED");
  const running = station.jobs.filter((j) => j.status === "IN_PROGRESS" && !j.heldUp);
  const queued = station.jobs.filter(
    (j) => j.status !== "IN_PROGRESS" && !j.heldUp && j.status !== "BLOCKED"
  );

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow={station.line ?? "Station"}
        title={station.name}
        actions={
          <Link
            href="/floor"
            className="inline-flex min-h-11 items-center text-sm text-steel-500 hover:text-navy-900"
          >
            Back to floor map
          </Link>
        }
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Here now" value={station.wip} />
        <Stat label="Running" value={station.running} />
        <Stat
          label="Held up"
          value={held.length}
          tone={held.length > 0 ? "alert" : "default"}
        />
        <Stat label="Finished today" value={station.doneToday} />
      </div>

      {station.jobs.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="Nothing here"
            hint="Work appears as soon as an order reaches this station."
          />
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <Group title="Held up" tone="alert" jobs={held} />
          <Group title="Running" jobs={running} />
          <Group title="Waiting their turn" jobs={queued} />
        </div>
      )}
    </div>
  );
}

function Group({
  title,
  jobs,
  tone,
}: {
  title: string;
  jobs: FloorJob[];
  tone?: "alert";
}) {
  if (jobs.length === 0) return null;
  return (
    <section>
      <p
        className={`mb-2 text-xs font-semibold uppercase tracking-wide ${
          tone === "alert" ? "text-blocked-fg" : "text-steel-400"
        }`}
      >
        {title} · {jobs.length}
      </p>
      <Panel className="divide-y divide-steel-100">
        {jobs.map((j) => (
          <div key={j.operationId} className="px-5 py-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={`/orders/${j.orderId}`}
                className="tnum inline-flex min-h-11 items-center font-semibold text-navy-800 hover:underline"
              >
                {j.orderNumber}
              </Link>
              <span className="text-xs text-steel-400">{formatRelativeDue(j.dueDate)}</span>
            </div>
            <p className="text-[0.9375rem] text-steel-900">{j.operationName}</p>
            <p className="text-sm text-steel-500">{j.itemName}</p>

            {/* Only what needs a person; queueing behind your own predecessor is
                normal flow and saying so on every row buries the rest. */}
            {j.blockers
              .filter((b) => b.kind !== "SEQUENCE")
              .map((b, i) => (
                <p key={i} className="mt-1.5 flex flex-wrap items-baseline gap-2 text-sm">
                  <Chip tone="alert">{b.label}</Chip>
                  <span className="text-steel-600">{b.detail}</span>
                </p>
              ))}
          </div>
        ))}
      </Panel>
    </section>
  );
}
