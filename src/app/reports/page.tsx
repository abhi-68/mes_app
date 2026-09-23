import { redirect } from "next/navigation";
import { getCurrentUser, isManager } from "@/lib/session";
import {
  averagesByStep,
  averagesByStation,
  averagesByWorker,
  qualityPareto,
  totalRecordedHours,
  qualityEventCount,
  materialsUsed,
  productsDelivered,
  type AverageRow,
} from "@/lib/reporting";
import {
  Panel,
  PageHeader,
  SectionHeading,
  EmptyState,
  Stat,
  StatusPill,
  formatMinutes,
  formatWhen,
} from "@/components/ui";

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!isManager(user.role)) redirect("/");

  const [byStep, byStation, byWorker, quality, hours, qualityCount, used, delivered] =
    await Promise.all([
      averagesByStep(),
      averagesByStation(),
      averagesByWorker(),
      qualityPareto(),
      totalRecordedHours(),
      qualityEventCount(),
      materialsUsed(),
      productsDelivered(),
    ]);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader title="Reports" />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Hours charged" value={hours} />
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
        <SectionHeading note="Managers only">Hours per person</SectionHeading>
        <AverageTable rows={byWorker} />
      </section>

      <section className="mt-8">
        <SectionHeading>
          Material used
        </SectionHeading>
        {used.length === 0 ? (
          <EmptyState
            title="Nothing issued yet"

          />
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Item</th>
                  <th className="px-5 py-2.5 text-right font-medium">Issued</th>
                  <th className="px-5 py-2.5 text-right font-medium">Returned</th>
                  <th className="px-5 py-2.5 text-right font-medium">Written off</th>
                  <th className="px-5 py-2.5 text-right font-medium">Used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {used.map((r) => (
                  <tr key={r.itemId}>
                    <td className="px-5 py-3">
                      <span className="text-gray-900">{r.name}</span>
                      <span className="ml-2 text-xs text-gray-400">{r.sku}</span>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-gray-500">
                      {r.issued}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-gray-400">
                      {r.returned || "—"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-danger-700">
                      {r.scrapped || "—"}
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums text-gray-900">
                      {r.used} {r.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </section>

      <section className="mt-8">
        <SectionHeading>
          Products delivered
        </SectionHeading>
        {delivered.length === 0 ? (
          <EmptyState
            title="Nothing has gone out yet"

          />
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Order</th>
                  <th className="px-5 py-2.5 font-medium">Product</th>
                  <th className="px-5 py-2.5 font-medium">Customer</th>
                  <th className="px-5 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-5 py-2.5 font-medium">State</th>
                  <th className="px-5 py-2.5 font-medium">Confirmed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {delivered.map((r) => (
                  <tr key={r.orderNumber}>
                    <td className="px-5 py-3 tabular-nums text-gray-900">{r.orderNumber}</td>
                    <td className="px-5 py-3 text-gray-700">{r.itemName}</td>
                    <td className="px-5 py-3 text-gray-500">{r.customerName ?? "—"}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-gray-900">
                      {r.quantity}
                    </td>
                    <td className="px-5 py-3">
                      <StatusPill status={r.status} size="sm" />
                    </td>
                    <td className="px-5 py-3 text-gray-500">
                      {r.shippedAt ? formatWhen(r.shippedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </section>

      <section className="mt-8">
        <SectionHeading>
          Scrap and rework by reason
        </SectionHeading>
        {quality.length === 0 ? (
          <EmptyState
            title="No scrap or rework recorded yet"

          />
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Reason</th>
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 text-right font-medium">Quantity</th>
                  <th className="px-5 py-2.5 text-right font-medium">Times logged</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {quality.map((r) => (
                  <tr key={`${r.type}-${r.label}`}>
                    <td className="px-5 py-3 text-gray-900">{r.label}</td>
                    <td className="px-5 py-3 text-gray-500">
                      {r.type === "SCRAP" ? "Scrap" : "Rework"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-gray-900">
                      {r.quantity}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-gray-400">
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

      />
    );
  }

  return (
    <Panel className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
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
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-5 py-3">
                <div className="text-gray-900">{r.label}</div>
                {r.sublabel && <div className="text-xs text-gray-400">{r.sublabel}</div>}
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-gray-400">{r.runs}</td>
              <td className="px-5 py-3 text-right tabular-nums text-gray-900">
                {formatMinutes(r.avgMinutes)}
              </td>
              {showEstimate && (
                <>
                  <td className="px-5 py-3 text-right tabular-nums text-gray-400">
                    {formatMinutes(r.estimateMinutes)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {r.ratio == null ? (
                      <span className="text-gray-300">—</span>
                    ) : (
                      <span
                        className={
                          r.ratio > 1.15
                            ? "font-medium text-danger-700"
                            : r.ratio < 0.85
                              ? "text-success-700"
                              : "text-gray-500"
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

