import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { stations, workOrderTasks } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { StationList } from "@/components/StationList";
import { PageHeader, SectionHeading } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * A worker's first screen: which machine are you on?
 *
 * Nothing else is on it. There is no useful thing to put in front of that
 * question, and a summary they have to click past every morning only costs them
 * time. Each station opens its own page.
 */
export default async function StationsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  // A supervisor asking "what is at each station" has the floor map for it.
  if (isManager(user.role)) redirect("/floor");

  const rows = await db
    .select({ id: stations.id, name: stations.name, line: stations.line })
    .from(stations)
    .where(eq(stations.active, true))
    .orderBy(asc(stations.sortOrder), asc(stations.id));

  // How much is sitting at each one, so the choice is informed rather than
  // alphabetical.
  const load = await db
    .select({
      stationId: workOrderTasks.stationId,
      running: sql<number>`count(*) filter (where ${workOrderTasks.status} = 'IN_PROGRESS')::int`,
      waiting: sql<number>`count(*) filter (where ${workOrderTasks.status} <> 'IN_PROGRESS')::int`,
    })
    .from(workOrderTasks)
    .where(inArray(workOrderTasks.status, ["PENDING", "IN_PROGRESS", "BLOCKED"]))
    .groupBy(workOrderTasks.stationId);
  const loadOf = new Map(load.map((l) => [l.stationId, l]));

  // Work with this person's name on it, wherever it is. Being handed a job is
  // useless if the only way to find out is to guess the right station first.
  const mine = await db.query.workOrderTasks.findMany({
    where: and(
      eq(workOrderTasks.assignedToUserId, user.id),
      inArray(workOrderTasks.status, ["PENDING", "IN_PROGRESS", "BLOCKED"])
    ),
    with: { station: true, workOrder: true },
    orderBy: [asc(workOrderTasks.sequence)],
  });

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-6 lg:px-8">
      <PageHeader title="Pick a station" subtitle="Open the station you are working at." />

      {mine.length > 0 && (
        <section className="mt-6">
          <SectionHeading note="Given to you by name">Yours to do next</SectionHeading>
          <div className="space-y-2">
            {mine.map((t) => (
              <Link
                key={t.id}
                href={`/my-station/${t.stationId}`}
                className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-gray-200 bg-white px-4 py-3 transition-colors duration-100 hover:bg-gray-50"
              >
                <span className="tnum text-sm font-semibold text-gray-950">
                  {t.jobNumber ?? t.workOrder.orderNumber}
                </span>
                <span className="flex-1 text-sm text-gray-700">{t.name}</span>
                <span className="text-sm text-gray-500">{t.station?.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="mt-6">
        <StationList
          stations={rows.map((s) => ({
            id: s.id,
            name: s.name,
            line: s.line,
            running: loadOf.get(s.id)?.running ?? 0,
            waiting: loadOf.get(s.id)?.waiting ?? 0,
          }))}
        />
      </div>
    </div>
  );
}
