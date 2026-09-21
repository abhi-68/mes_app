"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reserveMaterial } from "@/app/actions/materials";
import type { MaterialPlanRow } from "@/lib/material-planning";
import { Button, Chip, EmptyState, PageHeader, Panel, Stat } from "@/components/ui";

export function MaterialPlanning({ rows, locationName, canReserve, checkedAt }: {
  rows: MaterialPlanRow[]; locationName: string | null; canReserve: boolean; checkedAt: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Record<number, { error: boolean; text: string }>>({});
  const commands = useRef(new Map<number, string>());
  const stockRows = rows.filter(r => !r.fromSubassembly && r.uncovered > 0);
  const reservable = stockRows.filter(r => r.free > 0);
  const short = stockRows.filter(r => r.uncovered > r.free);
  const query = search.trim().toLowerCase();
  const shown = rows.filter(r => {
    const match = `${r.orderNumber} ${r.operationName} ${r.stationName ?? ""} ${r.itemName} ${r.sku}`.toLowerCase().includes(query);
    return match && (filter === "all" || (filter === "reserve" && !r.fromSubassembly && r.uncovered > 0 && r.free > 0)
      || (filter === "short" && !r.fromSubassembly && r.uncovered > r.free)
      || (filter === "assembly" && r.fromSubassembly));
  });

  function reserve(row: MaterialPlanRow) {
    if (pending) return;
    const commandId = commands.current.get(row.requirementId) ?? crypto.randomUUID();
    commands.current.set(row.requirementId, commandId);
    setBusyId(row.requirementId);
    startTransition(async () => {
      try {
        const response = await reserveMaterial({ requirementId: row.requirementId, commandId });
        if (!response.ok) {
          setFeedback(old => ({ ...old, [row.requirementId]: { error: true, text: response.error } }));
          return;
        }
        commands.current.delete(row.requirementId);
        const { reserved, uncovered } = response.result;
        setFeedback(old => ({ ...old, [row.requirementId]: { error: false,
          text: `${reserved} ${row.unit} reserved. ${uncovered > 0 ? `${uncovered} ${row.unit} still uncovered.` : "This material requirement is covered."}`,
        } }));
        router.refresh();
      } catch {
        setFeedback(old => ({ ...old, [row.requirementId]: { error: true,
          text: "No confirmation received. Retry this reservation safely; it will not reserve twice.",
        } }));
      } finally {
        setBusyId(null);
      }
    });
  }

  return <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-9">
    <PageHeader eyebrow="Material planning" title="What the open jobs need"
      subtitle="Setting stock aside promises it to one job so another cannot claim it. Nothing moves off the shelf until a worker scans the batch at the station." />
    <div className="mt-7 grid gap-4 sm:grid-cols-3">
      <Stat label="Can set aside" value={reservable.length} note="Jobs with some free stock waiting to be promised to them" />
      <Stat label="Short of stock" value={short.length} note="Not enough free stock to cover the remainder" tone={short.length ? "alert" : "default"} />
      <Stat label="Sub-assembly requirements" value={rows.filter(r => r.fromSubassembly).length} note="Supplied through child work orders" />
    </div>
    <Panel className="mt-6 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-steel-900">{locationName ? `Picking location: ${locationName}` : "No picking location configured"}</p>
          <p className="mt-1 text-sm text-steel-500">{canReserve ? "Set stock aside job by job below." : "Read-only view. A supervisor or admin can set stock aside."} Setting aside promises a quantity, not a particular batch — the worker&rsquo;s scan decides which one.</p>
          <p className="mt-1 text-xs text-steel-500">Free stock is shared between orders. Counts are a preview; each reservation checks again when saved. Other locations are not included.</p>
        </div>
        <Button disabled={pending} onClick={() => startTransition(() => router.refresh())}>Refresh availability</Button>
      </div>
      <p className="mt-2 text-xs text-steel-400">Checked at {checkedAt.replace("T", " ").slice(0, 19)} UTC</p>
    </Panel>
    <div className="my-5 flex flex-wrap gap-3">
      <label className="min-w-60 flex-1 text-sm text-steel-600">Search orders, parts or stations
        <input className="mt-1 min-h-11 w-full rounded-md border border-steel-300 bg-white px-3" value={search}
          onChange={e => setSearch(e.target.value)} placeholder="Order number, SKU or station" />
      </label>
      <label className="text-sm text-steel-600">Show
        <select className="mt-1 block min-h-11 rounded-md border border-steel-300 bg-white px-3" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All requirements</option><option value="reserve">Can set aside</option>
          <option value="short">Short of stock</option><option value="assembly">Sub-assemblies</option>
        </select>
      </label>
    </div>
    {!shown.length ? <EmptyState title={rows.length ? "No matching requirements" : "No open material requirements"}
      hint={rows.length ? "Try another search or filter." : "Release a work order with a bill of materials to see its requirements here."} />
      : <div className="space-y-4">{shown.map(row => {
        const reservableQty = Math.min(row.uncovered, row.free);
        const message = feedback[row.requirementId];
        return <Panel key={row.requirementId} className="px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><Link className="inline-flex min-h-11 items-center text-sm font-semibold text-navy-800 underline" href={`/orders/${row.orderId}`}>{row.orderNumber}</Link>
              <p className="font-medium text-steel-900">{row.itemName} <span className="font-mono text-xs text-steel-400">{row.sku}</span></p>
              <p className="mt-1 text-sm text-steel-500">{row.operationName} · {row.stationName ?? "No station assigned"}</p></div>
            <Chip tone={row.fromSubassembly ? "neutral" : row.uncovered === 0 ? "neutral" : "quiet"}>
              {row.fromSubassembly ? "Sub-assembly supply" : row.uncovered === 0 ? "Material covered" : "Needs reservation"}
            </Chip>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {[["Required", row.required], ["Net issued", row.issued], ["Reserved", row.reserved],
              ["From sub-assembly", row.supplied], ["Uncovered", row.uncovered]].map(([label, value]) =>
              <div key={label}><dt className="text-steel-500">{label}</dt><dd className="tnum mt-1 font-semibold text-steel-900">{value} {row.unit}</dd></div>)}
          </dl>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-steel-100 pt-3">
            {row.fromSubassembly ? <p className="text-sm text-steel-500">Follow the child order in the work-order tree. Stock reservation cannot replace its output handoff.</p>
              : <><p className="text-sm text-steel-600">{row.onHand} on hand · {row.held} on hold · <strong>{row.free} {row.unit} free</strong> · setting aside does not move it off the shelf</p>
                {canReserve && <Button tone="primary" disabled={pending || !locationName || reservableQty <= 0}
                  onClick={() => reserve(row)}>{busyId === row.requirementId ? "Setting aside…" : `Set aside${reservableQty > 0 ? ` ${reservableQty} ${row.unit}` : ""}`}</Button>}</>}
          </div>
          {message && <p role={message.error ? "alert" : "status"} className={`mt-3 text-sm ${message.error ? "text-blocked-fg" : "text-ok-fg"}`}>{message.text}</p>}
        </Panel>;
      })}</div>}
  </div>;
}
