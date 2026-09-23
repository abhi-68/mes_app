import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { floorMap, type FloorStation } from "@/lib/floor";
import { PageHeader, Panel, Stat, EmptyState, SectionHeading } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The plant on one screen.
 *
 * Read only, and deliberately shallow: a colour and a number per station, then a
 * page of its own for whatever is behind that. A map that also tries to be a list
 * is a screen you scroll rather than glance at.
 */
export default async function FloorPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { stations, lines, totals } = await floorMap();

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-9">
      <PageHeader eyebrow="Floor status" title="Floor map" />

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Running" value={totals.running} note="Steps under way" />
        <Stat
          label="Held up"
          value={totals.heldUp}
          tone={totals.heldUp > 0 ? "alert" : "default"}
          note="Waiting on someone else"
        />
        <Stat label="Queued" value={totals.queued} note="Waiting their turn" />
        <Stat label="Finished today" value={totals.doneToday} note="Steps completed" />
      </div>

      <section className="mt-8">
        <SectionHeading>
          The line
        </SectionHeading>

        {stations.length === 0 ? (
          <EmptyState title="No stations set up" hint="Add stations in Setup." />
        ) : (
          <div className="space-y-6">
            {lines.map((line) => (
              <div key={line.name ?? "single"}>
                {line.name && (
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {line.name}
                  </p>
                )}
                <div className="-mx-4 overflow-x-auto px-4 pb-1">
                  <div className="flex min-w-max items-center gap-2">
                    {line.stages.map((stage, i) => (
                      <div key={stage.position} className="flex items-center gap-2">
                        {/* Parallel stations sit side by side, so the row stays a row. */}
                        {stage.stations.map((st) => (
                          <StationTile key={st.id ?? "none"} station={st} />
                        ))}
                        {i < line.stages.length - 1 && (
                          <svg
                            viewBox="0 0 24 24"
                            className="h-4 w-4 shrink-0 text-gray-300"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <Legend />
      </section>
    </div>
  );
}

const STATE = {
  BLOCKED: { bar: "bg-danger-600", text: "text-danger-700", label: "Held up" },
  RUNNING: { bar: "bg-warning-500", text: "text-warning-700", label: "Running" },
  QUEUED: { bar: "bg-gray-400", text: "text-gray-500", label: "Waiting" },
  DONE: { bar: "bg-success-600", text: "text-success-700", label: "Clear" },
  IDLE: { bar: "bg-gray-300", text: "text-gray-400", label: "Empty" },
} as const;

function StationTile({ station }: { station: FloorStation }) {
  const tone = STATE[station.state];
  const href = station.id === null ? "/waiting" : `/floor/${station.id}`;

  return (
    <Panel as="section" interactive className="relative w-44 shrink-0 overflow-hidden">
      <span className={`absolute inset-x-0 top-0 h-1.5 ${tone.bar}`} aria-hidden />
      <Link href={href} className="flex min-h-11 flex-col px-4 pb-3.5 pt-4">
        <p
          className="truncate text-sm font-semibold leading-tight text-gray-900"
          title={station.name}
        >
          {station.name}
        </p>
        <p className="tnum mt-2 text-[2rem] font-semibold leading-none text-gray-950">
          {station.wip}
        </p>
        <p className={`mt-1 text-xs font-medium ${tone.text}`}>{tone.label}</p>
      </Link>
    </Panel>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["bg-danger-600", "Held up"],
    ["bg-warning-500", "Running"],
    ["bg-gray-400", "Waiting"],
    ["bg-success-600", "Clear"],
    ["bg-gray-300", "Empty"],
  ];
  return (
    <div className="mt-4 flex flex-wrap items-center gap-4">
      {items.map(([colour, label]) => (
        <span key={label} className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className={`h-2.5 w-2.5 rounded-sm ${colour}`} aria-hidden />
          {label}
        </span>
      ))}
    </div>
  );
}
