import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isManager } from "@/lib/session";
import { waitingOperations, type WaitingOperation } from "@/lib/dependencies";
import {
  PageHeader,
  Panel,
  SectionHeading,
  EmptyState,
  Stat,
  Chip,
  TH,
  TD,
  TR,
  formatRelativeDue,
} from "@/components/ui";

/**
 * The screen the whole project exists for.
 *
 * Thermal Corp's problem in one sentence: parts are built separately, meet at
 * final assembly, and nobody is told what they are waiting on. This answers that
 * for the whole floor at once — every step that cannot start, and why, in the
 * words a supervisor would use on the radio.
 */
export default async function WaitingPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!isManager(user.role)) redirect("/my-station");

  const waiting = await waitingOperations();

  // A step queued behind the one before it is normal flow. A step whose
  // sub-assembly has not arrived is the problem this system exists for, so the
  // two are never mixed into one number.
  const onWork = waiting.filter((w) => w.blockers.some((b) => b.kind === "DEPENDENCY"));
  const onMaterial = waiting.filter(
    (w) =>
      !w.blockers.some((b) => b.kind === "DEPENDENCY") &&
      w.blockers.some((b) => b.kind === "MATERIAL")
  );
  const queued = waiting.filter(
    (w) => w.blockers.every((b) => b.kind === "SEQUENCE")
  );
  const unitsAffected = new Set(
    [...onWork, ...onMaterial].map((w) => w.orderNumber.split("-").slice(0, 2).join("-"))
  ).size;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Floor status"
        title="What's waiting"
        subtitle={undefined}
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Held up"
          value={onWork.length + onMaterial.length}
          tone={onWork.length + onMaterial.length > 0 ? "alert" : "default"}
          note="Needs someone to act"
        />
        <Stat label="Units affected" value={unitsAffected} note="Top-level orders" />
        <Stat
          label="Queued"
          value={queued.length}
          tone="muted"
          note="Simply waiting their turn"
        />
      </div>

      {onWork.length + onMaterial.length === 0 && (
        <div className="mt-8">
          <EmptyState
            title="Nothing is held up"

          />
        </div>
      )}

      {onWork.length > 0 && (
        <section className="mt-8">
          <SectionHeading>
            Waiting on another part of the build
          </SectionHeading>
          <WaitingTable rows={onWork} />
        </section>
      )}

      {onMaterial.length > 0 && (
        <section className="mt-8">
          <SectionHeading>
            Waiting on material
          </SectionHeading>
          <WaitingTable rows={onMaterial} />
        </section>
      )}

      {queued.length > 0 && (
        <section className="mt-10">
          <SectionHeading>
            Queued behind an earlier step
          </SectionHeading>
          <Panel className="px-5 py-4">
            <p className="text-sm text-gray-500">
              {queued.length} step{queued.length === 1 ? "" : "s"} waiting{" "}
              {queued.length === 1 ? "its" : "their"} turn.
            </p>
          </Panel>
        </section>
      )}
    </div>
  );
}

function WaitingTable({ rows }: { rows: WaitingOperation[] }) {
  return (
    <Panel className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] table-fixed">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[20%]" />
            <col className="w-[44%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="bg-gray-50/60">
            <tr className="border-b border-gray-200">
              <th className={TH}>Step</th>
              <th className={TH}>Unit</th>
              <th className={TH}>Waiting on</th>
              <th className={`${TH} text-right`}>Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.operationId} className={TR}>
                <td className={TD}>
                  <p className="font-medium text-gray-900">{r.operationName}</p>
                  <p className="mt-0.5 text-xs text-gray-400">{r.stationName ?? "Unassigned"}</p>
                </td>
                <td className={TD}>
                  <Link
                    href={`/orders/${r.workOrderId}`}
                    title={r.itemName}
                    className="flex min-h-11 items-center truncate text-gray-700 underline-offset-2 hover:text-primary-600 hover:underline"
                  >
                    {r.itemName}
                  </Link>
                  <p className="tnum mt-0.5 text-xs text-gray-400">
                    {r.orderNumber}
                    {r.level > 0 && <span className="ml-1.5">sub-assembly</span>}
                  </p>
                </td>
                <td className={TD}>
                  <ul className="space-y-1.5">
                    {r.blockers.map((b, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <Chip tone={b.kind === "SEQUENCE" ? "quiet" : "alert"}>{b.label}</Chip>
                        <span className="text-gray-600">{b.detail}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={`${TD} whitespace-nowrap text-right text-gray-500`}>
                  {formatRelativeDue(r.dueDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
