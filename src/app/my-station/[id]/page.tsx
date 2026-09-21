import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { reasonCodes, stations, workOrderTasks } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { blockersForOperations, upstreamProgressFor } from "@/lib/dependencies";
import { pickListFor } from "@/lib/picking";
import { WorkerCard } from "@/components/WorkerCard";
import { EndShift } from "@/components/EndShift";
import { PageHeader, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

/** One station's jobs. Reached by pressing it on the station list. */
export default async function StationJobsPage(props: PageProps<"/my-station/[id]">) {
  const user = await getCurrentUser();
  if (!user) return null;
  if (isManager(user.role)) redirect("/floor");

  const { id } = await props.params;
  const stationId = Number(id);
  if (!Number.isSafeInteger(stationId)) notFound();

  const [station] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!station) notFound();

  // This station's work, plus anything given to this person by name wherever it
  // is — being handed a job is itself permission to do it, so it must not be
  // hidden from them.
  const open = await db.query.workOrderTasks.findMany({
    where: and(
      or(
        eq(workOrderTasks.stationId, stationId),
        eq(workOrderTasks.assignedToUserId, user.id)
      ),
      inArray(workOrderTasks.status, ["PENDING", "IN_PROGRESS", "BLOCKED"])
    ),
    with: { workOrder: { with: { item: true } }, timeEntries: true },
    orderBy: [asc(workOrderTasks.sequence)],
  });

  const problems = (
    await db
      .select({ id: reasonCodes.id, label: reasonCodes.label })
      .from(reasonCodes)
      .where(and(eq(reasonCodes.active, true), eq(reasonCodes.category, "BLOCKED")))
  ).slice(0, 6);

  const blockerMap = await blockersForOperations(open.map((t) => t.id));

  // How far along whatever each held-up job is waiting on has got.
  const waitingOnIds = [
    ...new Set(
      [...blockerMap.values()]
        .flat()
        .filter((b) => b.kind !== "SEQUENCE")
        .map((b) => b.sourceOperationId)
        .filter((v): v is number => typeof v === "number")
    ),
  ];
  const upstream = await upstreamProgressFor(waitingOnIds);

  const pickLists = new Map(
    await Promise.all(open.map(async (t) => [t.id, await pickListFor(t.id)] as const))
  );

  // Most urgent first, then in routing order.
  const jobs = open
    .map((t) => ({
      task: t,
      dueAt: t.workOrder.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.dueAt - b.dueAt || a.task.sequence - b.task.sequence)
    .map(({ task: t }) => ({
      id: t.id,
      name: t.name,
      jobNumber: t.jobNumber ?? t.workOrder.orderNumber,
      orderId: t.workOrderId,
      orderNumber: t.workOrder.orderNumber,
      itemName: t.workOrder.item.name,
      status: t.status,
      running: t.timeEntries.some((e) => e.endedAt === null),
      blockedNote: t.blockedNote,
      blockers: (blockerMap.get(t.id) ?? []).map((b) => ({
        label: b.label,
        detail: b.detail,
        waitingOn:
          b.sourceOperationId !== undefined ? (upstream.get(b.sourceOperationId) ?? null) : null,
      })),
      pickLines: pickLists.get(t.id) ?? [],
    }));

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-9">
      <PageHeader title={station.name} />

      <div className="mt-4">
        <Link
          href="/my-station"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-steel-500 hover:text-navy-900"
        >
          <span aria-hidden>←</span> All stations
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="Nothing here" hint="Nothing is waiting at this station." />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {jobs.map((job) => (
            <WorkerCard key={job.id} job={job} problems={problems} />
          ))}
        </div>
      )}

      <div className="mt-8">
        <EndShift name={user.name} />
      </div>
    </div>
  );
}
