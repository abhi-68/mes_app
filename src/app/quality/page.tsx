import { requireUser, isManager } from "@/lib/session";
import { inspectionQueue, qualitySummary, recentDispositions } from "@/lib/quality";
import { InspectionQueue } from "@/components/InspectionQueue";
import {
  PageHeader,
  Panel,
  Stat,
  Chip,
  SectionHeading,
  TH,
  TD,
  TR,
  formatWhen,
} from "@/components/ui";

export const dynamic = "force-dynamic";

const KIND_TONE: Record<string, "neutral" | "alert" | "quiet"> = {
  ACCEPT: "neutral",
  SCRAP: "alert",
  REWORK: "quiet",
  PRODUCED: "quiet",
};

export default async function QualityPage() {
  const user = await requireUser();
  const [queue, summary, history] = await Promise.all([
    inspectionQueue(),
    qualitySummary(),
    recentDispositions(),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Quality"
        title="Inspection"
        subtitle="Work for parts marked 'requires inspection' stops here until someone passes it. Passing hands the quantity straight to whatever is waiting on it."
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Awaiting inspection"
          value={summary.awaitingInspection}
          tone={summary.awaitingInspection > 0 ? "alert" : "default"}
          note="Made, not yet passed"
        />
        <Stat label="For rework" value={summary.awaitingRework} note="Sent back to be fixed" />
        <Stat label="Passed today" value={summary.acceptedToday} note="Units accepted" />
        <Stat label="Scrapped today" value={summary.scrappedToday} note="Units written off" />
      </div>

      <section className="mt-9">
        <SectionHeading note="Oldest due date first — the ones holding up an order are marked">
          The queue
        </SectionHeading>
        <InspectionQueue rows={queue} canInspect={isManager(user.role)} />
      </section>

      {history.length > 0 && (
        <section className="mt-10">
          <SectionHeading note="Every verdict, with the name of whoever gave it">
            Recent decisions
          </SectionHeading>
          <Panel className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem]">
                <thead className="bg-steel-50/60">
                  <tr className="border-b border-steel-200">
                    <th className={TH}>Verdict</th>
                    <th className={TH}>Part</th>
                    <th className={TH}>Step</th>
                    <th className={`${TH} text-right`}>Qty</th>
                    <th className={TH}>By</th>
                    <th className={TH}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className={TR}>
                      <td className={TD}>
                        <Chip tone={KIND_TONE[h.kind] ?? "quiet"}>{h.kind}</Chip>
                      </td>
                      <td className={TD}>
                        <p className="text-steel-700">{h.itemName}</p>
                        <p className="tnum mt-0.5 text-xs text-steel-400">{h.orderNumber}</p>
                      </td>
                      <td className={`${TD} text-steel-600`}>
                        {h.operationName}
                        {h.reason && (
                          <p className="mt-0.5 text-xs text-steel-400">{h.reason}</p>
                        )}
                      </td>
                      <td className={`${TD} tnum text-right text-steel-700`}>{h.quantity}</td>
                      <td className={`${TD} text-steel-600`}>{h.actorName ?? "—"}</td>
                      <td className={`${TD} whitespace-nowrap text-steel-500`}>
                        {formatWhen(h.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>
      )}
    </div>
  );
}
