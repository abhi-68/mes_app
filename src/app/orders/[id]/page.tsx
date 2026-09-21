import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workOrders } from "@/db/schema";
import { getProgressTree, type ProgressNode } from "@/lib/work-orders";
import { operationCode } from "@/lib/scan";
import { BarcodeLabel } from "@/components/BarcodeLabel";
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

  const pct = Math.round(tree.progress * 100);
  const blockers = tree.children.filter((c) => c.blockedCount > 0);
  const outstanding = tree.children.filter((c) => c.progress < 1);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        title={order.orderNumber}
        subtitle={
          <>
            {order.item.name}
            <span className="text-steel-300"> / </span>
            <span>Qty <span className="tnum">{order.quantity}</span></span>
            {order.customer && (
              <>
                <span className="text-steel-300"> / </span>
                {order.customer.name}
              </>
            )}
            <span className="text-steel-300"> / </span>
            {formatRelativeDue(order.dueDate)}
          </>
        }
        actions={<StatusPill status={order.status} />}
      />

      {/* Overall progress */}
      <Panel className="mt-6 p-5">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="tnum text-[2.5rem] font-semibold leading-none text-navy-900">
              {pct}%
            </div>
            <p className="mt-1 text-sm text-steel-500">
              <span className="tnum">{tree.tasksDone}</span> of{" "}
              <span className="tnum">{tree.tasksTotal}</span> steps complete across the whole
              unit
            </p>
          </div>
          {blockers.length > 0 && (
            <div className="rounded-lg bg-blocked-bg px-3.5 py-2.5 text-right">
              <div className="text-sm font-semibold text-blocked-fg">
                {tree.blockedCount} step{tree.blockedCount === 1 ? "" : "s"} blocked
              </div>
              <div className="text-xs text-blocked-fg/80">Final assembly cannot finish</div>
            </div>
          )}
        </div>
        <ProgressBar value={tree.progress} className="mt-4 h-3" tone="navy" />
      </Panel>

      {/* The question this page exists to answer */}
      {tree.children.length > 0 && (
        <Panel className="mt-4 border-l-4 border-l-navy-800 p-5">
          <h2 className="text-sm font-semibold text-navy-900">
            What final assembly is waiting on
          </h2>
          {outstanding.length === 0 ? (
            <p className="mt-2 text-sm text-ok-fg">
              Every sub-assembly is finished. Final assembly can run.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {outstanding.map((c) => (
                <li key={c.workOrderId} className="flex items-baseline gap-2 text-sm">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      c.blockedCount > 0 ? "bg-blocked-solid" : "bg-active-solid"
                    }`}
                    aria-hidden
                  />
                  <span className="font-medium text-steel-700">{c.itemName}</span>
                  <span className="text-steel-400">
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
        <Panel className="divide-y divide-steel-100">
          {tree.tasks.map((task) => (
            <StepRow key={task.id} task={task} />
          ))}
        </Panel>
      </section>

      <div className="mt-8">
        <Link
          href={`/orders/${orderId}/report`}
          className="inline-flex min-h-11 items-center rounded-md bg-navy-800 px-4 text-sm font-medium text-white hover:bg-navy-900"
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
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-navy-800">
          <span className="transition-transform group-open:rotate-90" aria-hidden>
            ▸
          </span>
          Traveler labels ({total} steps) — print and clip to the job
        </summary>

        <div className="mt-4 space-y-6">
          {groups.map((g) => (
            <div key={g.orderNumber}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-steel-400">
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
    <Panel className={isBlocked ? "border-blocked-solid/40" : ""}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <Link
            href={`/orders/${node.workOrderId}`}
            className="inline-flex min-h-11 items-center font-medium text-navy-900 hover:underline"
          >
            {node.itemName}
          </Link>
          <p className="mt-0.5 text-xs text-steel-400 tnum">
            {node.orderNumber} · {node.itemSku}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-40">
            <ProgressBar value={node.progress} tone={isBlocked ? "blocked" : "auto"} />
          </div>
          <span className="w-10 text-right text-sm font-medium tabular-nums text-steel-600">
            {pct}%
          </span>
          <StatusPill status={node.status} size="sm" />
        </div>
      </div>

      <ol className="divide-y divide-steel-100 border-t border-steel-100">
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
}: {
  task: ProgressNode["tasks"][number];
  compact?: boolean;
}) {
  const isBlocked = task.status === "BLOCKED";
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 px-5 ${
        compact ? "py-2.5" : "py-3.5"
      } ${isBlocked ? "bg-blocked-bg/40" : ""}`}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="w-4 shrink-0 text-right text-xs tabular-nums text-steel-400">
          {task.sequence}
        </span>
        <div className="min-w-0">
          <p
            className={`${compact ? "text-sm" : "text-sm font-medium"} ${
              task.status === "DONE" ? "text-steel-500" : "text-steel-900"
            }`}
          >
            {task.name}
          </p>
          <p className="mt-0.5 text-xs text-steel-400">
            {task.stationName ?? "Unassigned"}
            {task.expectedMinutes ? ` · ${formatMinutes(task.expectedMinutes)} est` : ""}
            {task.completedByName ? ` · ${task.completedByName}` : ""}
            {task.completedAt ? ` · ${formatWhen(task.completedAt)}` : ""}
          </p>
          {isBlocked && task.blockedNote && (
            <p className="mt-1 text-xs font-medium text-blocked-fg">{task.blockedNote}</p>
          )}
        </div>
      </div>
      <StatusPill status={task.status} size="sm" />
    </li>
  );
}
