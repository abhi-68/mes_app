import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { reasonCodes, stations, timeEntries, users, workOrderTasks } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { terminalStation } from "@/lib/terminal";
import { blockersForOperations, upstreamProgressFor } from "@/lib/dependencies";
import { pickListFor } from "@/lib/picking";
import { attachmentsForTask } from "@/lib/attachments";
import { recentlyFinishedAt } from "@/lib/outputs";
import { scheduleOpenWork } from "@/lib/schedule-data";
import { WorkerCard } from "@/components/WorkerCard";
import { PinStation } from "@/components/PinStation";
import { FinishedWork, type FinishedJob } from "@/components/FinishedWork";
import { EndShift } from "@/components/EndShift";
import { PageHeader, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

/** One station's jobs. Reached by pressing it on the station list. */
export default async function StationJobsPage(props: PageProps<"/my-station/[id]">) {
  const user = await getCurrentUser();
  if (!user) return null;
  /*
    Managers are NOT redirected away from here.

    `canWorkOnTask` already lets a manager act at any station, and a supervisor who
    steps in to help on a long weld needs the screen with the buttons on it. Their
    default landing page is still the floor map — the nav only offers Stations to
    workers — but the door is not locked against someone the server would let in.
  */

  const { id } = await props.params;
  const stationId = Number(id);
  if (!Number.isSafeInteger(stationId)) notFound();

  const [station] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!station) notFound();

  const terminal = await terminalStation();

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

  const scrapReasons = (
    await db
      .select({ id: reasonCodes.id, label: reasonCodes.label })
      .from(reasonCodes)
      .where(and(eq(reasonCodes.active, true), eq(reasonCodes.category, "SCRAP")))
  ).slice(0, 6);

  const blockerMap = await blockersForOperations(open.map((t) => t.id));

  // Every clock this person has running, anywhere. One operator minding three
  // machines is normal; being surprised by the split a month later is not.
  const myOpenClocks = (
    await db
      .select({ taskId: timeEntries.workOrderTaskId })
      .from(timeEntries)
      .where(and(eq(timeEntries.userId, user.id), isNull(timeEntries.endedAt)))
  ).length;

  // Only a supervisor hands work out, so only a supervisor is given the list.
  const people = isManager(user.role)
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.active, true), eq(users.role, "WORKER")))
        .orderBy(asc(users.name))
    : [];

  // A mistake usually surfaces after the step is done, so recently finished work
  // has to stay reachable from the bench.
  const finished: FinishedJob[] = (await recentlyFinishedAt(stationId)).map((t) => ({
    id: t.id,
    name: t.name,
    jobNumber: t.jobNumber ?? t.orderNumber,
    orderId: t.orderId,
    orderNumber: t.orderNumber,
    itemName: t.itemName,
    finishedAt: t.completedAt
      ? t.completedAt.toLocaleString("en-GB", {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "",
    writableOff: t.writableOff,
    fitted: t.fitted,
  }));

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

  // The unit's general arrangement follows the job to the bench, so nobody has to
  // go and find the order to see what they are building.
  const drawings = new Map(
    await Promise.all(
      open.map(
        async (t) => [t.id, await attachmentsForTask(t.id, t.workOrderId)] as const
      )
    )
  );

  // When this part actually has to be finished for the unit to stay on time. The
  // order's own due date is the unit's ship date, which is days later and is not
  // the number the person at this bench needs.
  const plant = await scheduleOpenWork();

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
      instructions: t.instructions,
      running: t.timeEntries.some((e) => e.endedAt === null),
      mine: t.timeEntries.some((e) => e.endedAt === null && e.userId === user.id),
      sharedWith: t.timeEntries.some((e) => e.endedAt === null && e.userId === user.id)
        ? myOpenClocks - 1
        : 0,
      yours: t.assignedToUserId === user.id,
      blockedNote: t.blockedNote,
      blockers: (blockerMap.get(t.id) ?? []).map((b) => ({
        label: b.label,
        detail: b.detail,
        waitingOn:
          b.sourceOperationId !== undefined ? (upstream.get(b.sourceOperationId) ?? null) : null,
      })),
      pickLines: pickLists.get(t.id) ?? [],
      drawings: drawings.get(t.id) ?? [],
      neededBy: plant.neededBy.get(t.workOrderId) ?? null,
    }));

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 lg:px-8">
      <PinStation stationId={stationId} pinnedTo={terminal?.id ?? null} />
      <Link
        href="/my-station"
        className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-950"
      >
        <span aria-hidden>←</span> All stations
      </Link>

      <PageHeader title={station.name} />

      {jobs.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Nothing here" hint="Nothing is waiting at this station." />
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {jobs.map((job) => (
            <WorkerCard
              key={job.id}
              job={job}
              problems={problems}
              scrapReasons={scrapReasons}
              people={people}
            />
          ))}
        </div>
      )}

      <div className="mt-8">
        <FinishedWork jobs={finished} scrapReasons={scrapReasons} />
      </div>

      <div className="mt-8">
        <EndShift name={user.name} />
      </div>
    </div>
  );
}
