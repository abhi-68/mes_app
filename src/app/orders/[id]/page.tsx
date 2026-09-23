import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workOrders } from "@/db/schema";
import { getProgressTree, type ProgressNode } from "@/lib/work-orders";
import { scheduleOpenWork } from "@/lib/schedule-data";
import { DEFAULT_CALENDAR, workingMinutesBetween } from "@/lib/schedule";
import { attachmentsForOrder, stepAttachments } from "@/lib/attachments";
import type { AttachmentSummary } from "@/lib/attachment-shared";
import { shortagesForOrder } from "@/lib/shortages";
import { getCurrentUser, isManager } from "@/lib/session";
import { operationCode } from "@/lib/scan";
import { BarcodeLabel } from "@/components/BarcodeLabel";
import { OrderSchedule } from "@/components/OrderSchedule";
import { Drawings } from "@/components/Drawings";
import { Shortages } from "@/components/Shortages";
import {
  Panel,
  PageHeader,
  ProgressBar,
  StatusPill,
  SectionHeading,
  formatMinutes,
  formatRelativeDue,
  formatWhen,
} from "@/components/ui";

export default async function OrderDetailPage(props: PageProps<"/orders/[id]">) {
  const { id } = await props.params;
  const orderId = Number(id);
  if (Number.isNaN(orderId)) notFound();

  const order = await db.query.workOrders.findFirst({
    where: eq(workOrders.id, orderId),
    with: { item: true, customer: true },
  });
  if (!order) notFound();

  const tree = await getProgressTree(orderId);
  if (!tree) notFound();

  // Scheduled against every other live job, not in isolation — see scheduleOpenWork.
  const plant = await scheduleOpenWork();
  const projection = plant.schedule.orders.get(orderId) ?? null;
  const subAssemblyDeadlines = tree.children.map((c) => ({
    workOrderId: c.workOrderId,
    name: c.itemName,
    neededBy: plant.neededBy.get(c.workOrderId) ?? null,
    done: c.progress >= 1,
  }));

  const viewer = await getCurrentUser();
  const drawings = await attachmentsForOrder(orderId);
  const shortages = await shortagesForOrder(orderId);
  const perStep = await stepAttachments(tree.tasks.map((t) => t.id));
  const canUpload = viewer ? isManager(viewer.role) : false;

  const pct = Math.round(tree.progress * 100);
  const blockers = tree.children.filter((c) => c.blockedCount > 0);
  const outstanding = tree.children.filter((c) => c.progress < 1);

  // How long the build itself takes, separate from when it could start. With
  // parts missing there is no honest start, but "can we build 20 in the time
  // left" is still answerable.
  const now = plant.schedule.computedAt;
  const workMinutes = projection
    ? workingMinutesBetween(DEFAULT_CALENDAR, now, projection.projectedFinish)
    : 0;
  const minutesUntilDue = order.dueDate
    ? workingMinutesBetween(DEFAULT_CALENDAR, now, order.dueDate)
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        title={order.orderNumber}
        subtitle={
          <>
            {order.item.name}
            <span className="text-gray-300"> / </span>
            <span>Qty <span className="tnum">{order.quantity}</span></span>
            {order.customer && (
              <>
                <span className="text-gray-300"> / </span>
                {order.customer.name}
              </>
            )}
            <span className="text-gray-300"> / </span>
            {formatRelativeDue(order.dueDate)}
          </>
        }
        actions={<StatusPill status={order.status} />}
      />

      {/* Whether the parts exist gates everything below it, so it goes first. */}
      <Shortages shortages={shortages} canBuy={canUpload} />

      {(order.dimensions || order.materialType) && (
        <Panel className="mt-4 p-5">
          <h2 className="text-sm font-semibold text-gray-950">What was ordered</h2>
          <dl className="mt-2 grid gap-3 sm:grid-cols-2">
            {order.dimensions && (
              <div>
                <dt className="text-xs text-gray-500">Size</dt>
                <dd className="text-sm text-gray-900">{order.dimensions}</dd>
              </div>
            )}
            {order.materialType && (
              <div>
                <dt className="text-xs text-gray-500">Material</dt>
                <dd className="text-sm text-gray-900">{order.materialType}</dd>
              </div>
            )}
          </dl>
        </Panel>
      )}

      {/* Overall progress */}
      <Panel className="mt-6 p-5">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="tnum text-[2.5rem] font-semibold leading-none text-gray-950">
              {pct}%
            </div>
            <p className="mt-1 text-sm text-gray-500">
              <span className="tnum">{tree.tasksDone}</span> of{" "}
              <span className="tnum">{tree.tasksTotal}</span> steps complete across the whole
              unit
            </p>
          </div>
          {blockers.length > 0 && (
            <div className="rounded-lg bg-danger-50 px-3.5 py-2.5 text-right">
              <div className="text-sm font-semibold text-danger-700">
                {tree.blockedCount} step{tree.blockedCount === 1 ? "" : "s"} blocked
              </div>
              <div className="text-xs text-danger-700/80">Final assembly cannot finish</div>
            </div>
          )}
        </div>
        <ProgressBar value={tree.progress} className="mt-4 h-3" tone="navy" />
      </Panel>

      <OrderSchedule
        projectedFinish={projection?.projectedFinish ?? null}
        dueDate={order.dueDate}
        lateByMinutes={projection?.lateByMinutes ?? null}
        shortItems={shortages.length}
        workMinutes={workMinutes}
        minutesUntilDue={minutesUntilDue}
        subAssemblies={subAssemblyDeadlines}
        guessedDurations={plant.schedule.guessedDurations}
        totalSteps={plant.tasks.length}
        computedAt={plant.schedule.computedAt}
      />

      <Drawings
        workOrderId={orderId}
        files={drawings}
        canUpload={canUpload}
      />

      {/* The question this page exists to answer */}
      {tree.children.length > 0 && (
        <Panel className="mt-4 border-l-4 border-l-primary-600 p-5">
          <h2 className="text-sm font-semibold text-gray-950">
            What final assembly is waiting on
          </h2>
          {outstanding.length === 0 ? (
            <p className="mt-2 text-sm text-success-700">
              Every sub-assembly is finished. Final assembly can run.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {outstanding.map((c) => (
                <li key={c.workOrderId} className="flex items-baseline gap-2 text-sm">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      c.blockedCount > 0 ? "bg-danger-600" : "bg-warning-500"
                    }`}
                    aria-hidden
                  />
                  <span className="font-medium text-gray-700">{c.itemName}</span>
                  <span className="text-gray-400">
                    {c.blockedCount > 0
                      ? blockerNote(c)
                      : `${Math.round(c.progress * 100)}% done`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {/* Sub-assemblies, each with its own progress and its own steps */}
      {tree.children.length > 0 && (
        <section className="mt-8">
          <SectionHeading note={`${tree.children.length} sub-assemblies`}>
            Sub-assemblies
          </SectionHeading>
          <div className="space-y-3">
            {tree.children.map((child) => (
              <SubAssemblyCard key={child.workOrderId} node={child} />
            ))}
          </div>
        </section>
      )}

      {/* The unit's own steps */}
      <section className="mt-8">
        <SectionHeading note={`${tree.tasks.length} steps`}>
          Final assembly &amp; dispatch
        </SectionHeading>
        <Panel className="divide-y divide-gray-100">
          {tree.tasks.map((task) => (
            <StepRow
              key={task.id}
              task={task}
              drawings={perStep.get(task.id) ?? []}
              canUpload={canUpload}
            />
          ))}
        </Panel>
      </section>

      <div className="mt-8">
        <Link
          href={`/orders/${orderId}/report`}
          className="inline-flex min-h-11 items-center rounded-lg bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800"
        >
          Production report
        </Link>
      </div>

      <Traveler tree={tree} />
    </div>
  );
}

/**
 * The traveler — one barcode per step, for printing and clipping to the job.
 *
 * Collapsed by default because it is paper output, not a screen anyone reads.
 * Scanning one of these at a station puts that step's card on top of the
 * operator's list, which is the whole point: the job tells the system where it
 * is, instead of somebody walking the floor to find out.
 */
function Traveler({ tree }: { tree: ProgressNode }) {
  const groups: { orderNumber: string; itemName: string; tasks: ProgressNode["tasks"] }[] = [
    { orderNumber: tree.orderNumber, itemName: tree.itemName, tasks: tree.tasks },
    ...tree.children.map((c) => ({
      orderNumber: c.orderNumber,
      itemName: c.itemName,
      tasks: c.tasks,
    })),
  ].filter((g) => g.tasks.length > 0);

  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  return (
    <section className="mt-10">
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-gray-800">
          <span className="transition-transform group-open:rotate-90" aria-hidden>
            ▸
          </span>
          Traveler labels ({total} steps) — print and clip to the job
        </summary>

        <div className="mt-4 space-y-6">
          {groups.map((g) => (
            <div key={g.orderNumber}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                {g.itemName} · <span className="tnum">{g.orderNumber}</span>
              </p>
              <div className="flex flex-wrap gap-3">
                {g.tasks.map((task) => (
                  <BarcodeLabel
                    key={task.id}
                    code={operationCode(task.id)}
                    itemName={task.name}
                    sku={`${g.orderNumber} · step ${task.sequence}`}
                    storageLocation={task.stationName ?? "Unassigned"}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function blockerNote(node: ProgressNode): string {
  const blocked = node.tasks.find((t) => t.status === "BLOCKED");
  return blocked?.blockedNote ? `blocked — ${blocked.blockedNote}` : "blocked";
}

function SubAssemblyCard({ node }: { node: ProgressNode }) {
  const pct = Math.round(node.progress * 100);
  const isBlocked = node.blockedCount > 0;

  return (
    <Panel className={isBlocked ? "ring-danger-600/40" : ""}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <Link
            href={`/orders/${node.workOrderId}`}
            className="inline-flex min-h-11 items-center font-medium text-gray-950 hover:underline"
          >
            {node.itemName}
          </Link>
          <p className="mt-0.5 text-xs text-gray-400 tnum">
            {node.orderNumber} · {node.itemSku}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-40">
            <ProgressBar value={node.progress} tone={isBlocked ? "blocked" : "auto"} />
          </div>
          <span className="w-10 text-right text-sm font-medium tabular-nums text-gray-600">
            {pct}%
          </span>
          <StatusPill status={node.status} size="sm" />
        </div>
      </div>

      <ol className="divide-y divide-gray-100 border-t border-gray-100">
        {node.tasks.map((task) => (
          <StepRow key={task.id} task={task} compact />
        ))}
      </ol>
    </Panel>
  );
}

function StepRow({
  task,
  compact = false,
  drawings,
  canUpload = false,
}: {
  task: ProgressNode["tasks"][number];
  compact?: boolean;
  drawings?: AttachmentSummary[];
  canUpload?: boolean;
}) {
  const isBlocked = task.status === "BLOCKED";
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 px-5 ${
        compact ? "py-2.5" : "py-3.5"
      } ${isBlocked ? "bg-danger-50/40" : ""}`}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="w-4 shrink-0 text-right text-xs tabular-nums text-gray-400">
          {task.sequence}
        </span>
        <div className="min-w-0">
          <p
            className={`${compact ? "text-sm" : "text-sm font-medium"} ${
              task.status === "DONE" ? "text-gray-500" : "text-gray-900"
            }`}
          >
            {task.name}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {task.stationName ?? "Unassigned"}
            {task.expectedMinutes ? ` · ${formatMinutes(task.expectedMinutes)} est` : ""}
            {task.completedByName ? ` · ${task.completedByName}` : ""}
            {task.completedAt ? ` · ${formatWhen(task.completedAt)}` : ""}
          </p>
          {isBlocked && task.blockedNote && (
            <p className="mt-1 text-xs font-medium text-danger-700">{task.blockedNote}</p>
          )}
          {/* A drawing for THIS operation, not the whole unit — a cut list belongs
              at the saw and nowhere else. */}
          {(canUpload || (drawings && drawings.length > 0)) && (
            <div className="mt-2">
              <Drawings
                workOrderTaskId={task.id}
                files={drawings ?? []}
                canUpload={canUpload}
                heading="For this step"
                compact
              />
            </div>
          )}
        </div>
      </div>
      <StatusPill status={task.status} size="sm" />
    </li>
  );
}
