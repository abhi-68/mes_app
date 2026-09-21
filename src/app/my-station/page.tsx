import { redirect } from "next/navigation";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { stations, workOrderTasks } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { StationList } from "@/components/StationList";
import { PageHeader } from "@/components/ui";

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

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader title="Pick a station" />
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
