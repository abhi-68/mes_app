import { redirect } from "next/navigation";
import { getCurrentUser, isManager } from "@/lib/session";
import {
  averagesByStep,
  averagesByStation,
  averagesByWorker,
  qualityPareto,
  totalRecordedHours,
  qualityEventCount,
  type AverageRow,
} from "@/lib/reporting";
import {
  Panel,
  PageHeader,
  SectionHeading,
  EmptyState,
  Stat,
  formatMinutes,
} from "@/components/ui";

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!isManager(user.role)) redirect("/");

  const [byStep, byStation, byWorker, quality, hours, qualityCount] = await Promise.all([
    averagesByStep(),
    averagesByStation(),
    averagesByWorker(),
    qualityPareto(),
    totalRecordedHours(),
    qualityEventCount(),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        title="Reports"
        subtitle="Everything here is computed from recorded start/stop times and reason codes — nothing is typed in by hand."
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Hours charged"
          value={hours}
          note="Shared clock-ons counted once"
        />
        <Stat
          label="Steps measured"
          value={byStep.reduce((s, r) => s + r.runs, 0)}
          note="Completed runs"
        />
        <Stat
          label="Quality events"
          value={qualityCount}
          tone={qualityCount > 0 ? "alert" : "default"}
          note="Scrap and rework logged"
        />
      </div>

      <section className="mt-8">
        <SectionHeading note="Actual vs estimate">Average time per step</SectionHeading>
        <AverageTable rows={byStep} showEstimate />
      </section>

      <section className="mt-8">
        <SectionHeading note="Where the hours go">Average time per station</SectionHeading>
        <AverageTable rows={byStation} />
      </section>

      <section className="mt-8">
        <SectionHeading note="Managers only">Average time per person</SectionHeading>
        <AverageTable rows={byWorker} />
      </section>

      <section className="mt-8">
        <SectionHeading note="Biggest first — fix the top of this list">
          Scrap and rework by reason
        </SectionHeading>
        {quality.length === 0 ? (
          <EmptyState
            title="No scrap or rework recorded yet"
            hint="Workers log these from their station screen, with a reason code so they can be counted."
          />
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-steel-50 text-left text-xs text-steel-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Reason</th>
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 text-right font-medium">Quantity</th>
                  <th className="px-5 py-2.5 text-right font-medium">Times logged</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-100">
                {quality.map((r) => (
                  <tr key={`${r.type}-${r.label}`}>
                    <td className="px-5 py-3 text-steel-900">{r.label}</td>
                    <td className="px-5 py-3 text-steel-500">
                      {r.type === "SCRAP" ? "Scrap" : "Rework"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-steel-900">
                      {r.quantity}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-steel-400">
                      {r.occurrences}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </section>
    </div>
  );
}

function AverageTable({ rows, showEstimate = false }: { rows: AverageRow[]; showEstimate?: boolean }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Not enough recorded time yet"
        hint="Averages appear once steps have been clocked from start to finish."
      />
    );
  }

  return (
    <Panel className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-steel-50 text-left text-xs text-steel-500">
          <tr>
            <th className="px-5 py-2.5 font-medium">Name</th>
            <th className="px-5 py-2.5 text-right font-medium">Runs</th>
            <th className="px-5 py-2.5 text-right font-medium">Average</th>
            {showEstimate && (
              <>
                <th className="px-5 py-2.5 text-right font-medium">Estimate</th>
                <th className="px-5 py-2.5 text-right font-medium">Difference</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-steel-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-5 py-3">
                <div className="text-steel-900">{r.label}</div>
                {r.sublabel && <div className="text-xs text-steel-400">{r.sublabel}</div>}
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-steel-400">{r.runs}</td>
              <td className="px-5 py-3 text-right tabular-nums text-steel-900">
                {formatMinutes(r.avgMinutes)}
              </td>
              {showEstimate && (
                <>
                  <td className="px-5 py-3 text-right tabular-nums text-steel-400">
                    {formatMinutes(r.estimateMinutes)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {r.ratio == null ? (
                      <span className="text-steel-300">—</span>
                    ) : (
                      <span
                        className={
                          r.ratio > 1.15
                            ? "font-medium text-blocked-fg"
                            : r.ratio < 0.85
                              ? "text-ok-fg"
                              : "text-steel-500"
                        }
                      >
                        {r.ratio > 1 ? "+" : ""}
                        {Math.round((r.ratio - 1) * 100)}%
                      </span>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

