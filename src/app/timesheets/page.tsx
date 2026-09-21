import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { timeEntries } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { effectiveSeconds } from "@/lib/reporting";
import { prorate } from "@/lib/timesheets";
import { TimesheetTable, type TimesheetRow } from "@/components/TimesheetTable";
import { PageHeader, EmptyState, Panel } from "@/components/ui";

export default async function TimesheetsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const manager = isManager(user.role);

  // Open entries are loaded too, and then filtered out of the table below. They
  // have to be in the pool or a finished entry that overlapped something still
  // running would be charged for time the worker was not giving it.
  const entries = await db.query.timeEntries.findMany({
    where: manager ? undefined : eq(timeEntries.userId, user.id),
    orderBy: [desc(timeEntries.startedAt)],
    limit: 200,
    with: {
      user: true,
      adjustments: { with: { adjustedBy: true } },
      task: { with: { workOrder: true } },
    },
  });

  const charged = prorate(
    entries.map((e) => ({
      id: e.id,
      userId: e.userId,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      durationSeconds: e.durationSeconds,
      adjustedSeconds: e.adjustments.length > 0 ? effectiveSeconds(e) : null,
    }))
  );

  const rows: TimesheetRow[] = entries
    .filter((e) => e.endedAt !== null)
    .map((e) => {
      const split = charged.get(e.id);
      return {
        id: e.id,
        workerName: e.user.name,
        stepName: e.task.name,
        orderNumber: e.task.workOrder.orderNumber,
        startedAt: e.startedAt.toISOString(),
        endedAt: e.endedAt?.toISOString() ?? null,
        originalSeconds: e.durationSeconds,
        effectiveSeconds: effectiveSeconds(e),
        chargedSeconds: split?.chargedSeconds ?? effectiveSeconds(e),
        sharedWith: split?.shared ? split.peakConcurrency : 0,
        adjustments: e.adjustments.map((a) => ({
          by: a.adjustedBy.name,
          reason: a.reason,
          newSeconds: a.newDurationSeconds,
          at: a.createdAt.toISOString(),
        })),
      };
    });

  const sharedCount = rows.filter((r) => r.sharedWith > 1).length;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        title="Timesheets"
        subtitle={
          manager
            ? "Recorded automatically from Start to Mark done. You can correct an entry, but the original is kept and your name goes on the change."
            : "Your recorded time. These are captured automatically and cannot be edited — ask a supervisor if something is wrong."
        }
      />

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            title="No completed time entries yet"
            hint="An entry is created when someone starts a step and closed when they mark it done."
          />
        ) : (
          <TimesheetTable rows={rows} canAdjust={manager} />
        )}
      </div>

      <Panel className="mt-6 space-y-3 px-5 py-4">
        <p className="text-sm text-steel-500">
          Time entries are append-only. A correction never overwrites what was recorded — it is
          stored as a separate row naming who changed it, what it was before, what it became and
          why, so the original is always recoverable.
        </p>
        <p className="text-sm text-steel-500">
          <span className="font-medium text-steel-700">On the clock</span> is how long the step
          was open. <span className="font-medium text-steel-700">Charged to the job</span> shares
          that time out when someone had more than one step running at once — an hour minding
          three machines is an hour of work, not three.
          {sharedCount > 0
            ? ` ${sharedCount} ${sharedCount === 1 ? "entry" : "entries"} below ${sharedCount === 1 ? "was" : "were"} shared this way.`
            : " Nothing below overlapped, so the two columns match."}
        </p>
      </Panel>
    </div>
  );
}
