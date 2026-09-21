import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { productionReport } from "@/lib/production-report";
import {
  PageHeader, Panel, Chip, SectionHeading, TH, TD, TR, formatWhen, formatMinutes,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ProductionReportPage(props: PageProps<"/orders/[id]/report">) {
  await requireUser();
  const { id } = await props.params;
  const orderId = Number(id);
  if (!Number.isSafeInteger(orderId)) notFound();

  const r = await productionReport(orderId);
  if (!r) notFound();

  const done = r.steps.filter((s) => s.status === "DONE").length;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Production report"
        title={r.itemName}
        subtitle={`${r.orderNumber}${r.customerName ? ` · ${r.customerName}` : ""}`}
        actions={
          <Link
            href={`/orders/${orderId}`}
            className="inline-flex min-h-11 items-center text-sm text-steel-500 hover:text-navy-900"
          >
            Back to order
          </Link>
        }
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        {[
          ["Product", `${r.itemName} · ${r.sku}`],
          ["Quantity", String(r.quantity)],
          ["Steps complete", `${done} of ${r.steps.length}`],
          [
            "Time on the job",
            r.expectedMinutes > 0
              ? `${formatMinutes(r.totalMinutes)} of ${formatMinutes(r.expectedMinutes)} planned`
              : formatMinutes(r.totalMinutes),
          ],
        ].map(([label, value]) => (
          <Panel key={label} className="px-4 py-3">
            <p className="eyebrow">{label}</p>
            <p className="tnum mt-1 text-lg font-semibold text-navy-900">{value}</p>
          </Panel>
        ))}
      </div>

      {/* --- Steps --- */}
      <section className="mt-8">
        <SectionHeading note="Who signed each one off, and how long it took">Steps</SectionHeading>
        <Panel className="overflow-hidden">
          <table className="w-full">
            <thead className="bg-steel-50/60">
              <tr className="border-b border-steel-200">
                <th className={TH}>#</th>
                <th className={TH}>Step</th>
                <th className={TH}>Station</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Time</th>
                <th className={TH}>By</th>
                <th className={TH}>When</th>
              </tr>
            </thead>
            <tbody>
              {r.steps.map((s, i) => (
                <tr key={i} className={TR}>
                  <td className={`${TD} tnum text-steel-400`}>{s.sequence}</td>
                  <td className={`${TD} text-steel-800`}>{s.name}</td>
                  <td className={`${TD} text-steel-600`}>{s.stationName ?? "—"}</td>
                  <td className={TD}>
                    <Chip tone={s.status === "DONE" ? "neutral" : "quiet"}>{s.status}</Chip>
                  </td>
                  <td className={`${TD} tnum whitespace-nowrap text-right text-steel-700`}>
                    {s.minutes > 0 ? formatMinutes(s.minutes) : "—"}
                    {s.expectedMinutes ? (
                      <span className="block text-xs text-steel-400">
                        est {formatMinutes(s.expectedMinutes)}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${TD} text-steel-600`}>{s.completedBy ?? "—"}</td>
                  <td className={`${TD} whitespace-nowrap text-steel-500`}>
                    {s.completedAt ? formatWhen(s.completedAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>

      {/* --- Materials, with the heats --- */}
      <section className="mt-8">
        <SectionHeading
          note={
            r.untracedIssues > 0
              ? `${r.untracedIssues} issue${r.untracedIssues === 1 ? "" : "s"} had no batch behind them`
              : "Every issue traced to a batch"
          }
        >
          Material consumed
        </SectionHeading>
        {r.materials.length === 0 ? (
          <Panel className="px-5 py-4">
            <p className="text-sm text-steel-500">Nothing has been drawn against this order yet.</p>
          </Panel>
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full">
              <thead className="bg-steel-50/60">
                <tr className="border-b border-steel-200">
                  <th className={TH}>Part</th>
                  <th className={TH}>Used at</th>
                  <th className={`${TH} text-right`}>Qty</th>
                  <th className={TH}>Batch</th>
                  <th className={TH}>Heat</th>
                </tr>
              </thead>
              <tbody>
                {r.materials.map((m, i) => (
                  <tr key={i} className={TR}>
                    <td className={TD}>
                      <p className="text-steel-800">{m.itemName}</p>
                      <p className="tnum mt-0.5 font-mono text-xs text-steel-400">{m.sku}</p>
                    </td>
                    <td className={`${TD} text-steel-600`}>{m.stepName}</td>
                    <td className={`${TD} tnum text-right text-steel-800`}>
                      {m.quantity} {m.unit}
                    </td>
                    <td className={TD}>
                      {m.batchNumber ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="tnum font-mono text-xs">{m.batchNumber}</span>
                          {/* The difference between knowing and assuming. */}
                          {m.assumed && <Chip tone="quiet">assumed</Chip>}
                        </span>
                      ) : (
                        <Chip tone="quiet">No batch</Chip>
                      )}
                    </td>
                    <td className={`${TD} tnum font-mono text-xs text-steel-600`}>
                      {m.heatNumber ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </section>

      {/* --- Quality --- */}
      {r.quality.length > 0 && (
        <section className="mt-8">
          <SectionHeading note="Every verdict, with a name against it">Quality</SectionHeading>
          <Panel className="overflow-hidden">
            <table className="w-full">
              <thead className="bg-steel-50/60">
                <tr className="border-b border-steel-200">
                  <th className={TH}>Verdict</th>
                  <th className={TH}>Step</th>
                  <th className={`${TH} text-right`}>Qty</th>
                  <th className={TH}>Reason</th>
                  <th className={TH}>By</th>
                </tr>
              </thead>
              <tbody>
                {r.quality.map((q, i) => (
                  <tr key={i} className={TR}>
                    <td className={TD}>
                      <Chip tone={q.kind === "SCRAP" ? "alert" : "quiet"}>{q.kind}</Chip>
                    </td>
                    <td className={`${TD} text-steel-600`}>{q.stepName}</td>
                    <td className={`${TD} tnum text-right text-steel-800`}>{q.quantity}</td>
                    <td className={`${TD} text-steel-600`}>{q.reason ?? "—"}</td>
                    <td className={`${TD} text-steel-600`}>{q.actorName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </section>
      )}

      {/* --- Sub-assemblies and dispatch --- */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {r.subAssemblies.length > 0 && (
          <section>
            <SectionHeading>Built for this unit</SectionHeading>
            <Panel className="divide-y divide-steel-100">
              {r.subAssemblies.map((c) => (
                <div key={c.orderNumber} className="flex items-center justify-between px-5 py-3">
                  <span className="text-sm text-steel-800">{c.itemName}</span>
                  <span className="tnum text-xs text-steel-400">{c.orderNumber}</span>
                </div>
              ))}
            </Panel>
          </section>
        )}

        <section>
          <SectionHeading>Dispatch</SectionHeading>
          <Panel className="divide-y divide-steel-100">
            {r.shipments.length === 0 ? (
              <p className="px-5 py-4 text-sm text-steel-500">Not shipped.</p>
            ) : (
              r.shipments.map((s) => (
                <div key={s.noteNumber} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span className="tnum text-sm font-medium text-steel-900">{s.noteNumber}</span>
                  <span className="text-sm text-steel-600">
                    {s.quantity} · {s.handlerName ?? "unassigned"}
                  </span>
                  <Chip tone={s.status === "DELIVERED" ? "neutral" : "quiet"}>{s.status}</Chip>
                </div>
              ))
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}
