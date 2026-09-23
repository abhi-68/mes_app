"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordInspection } from "@/app/actions/quality";
import type { InspectionItem } from "@/lib/quality";
import { Button, Chip, EmptyState, Panel } from "@/components/ui";

type Verdict = "PASS" | "REWORK" | "SCRAP";
type Source = "pendingInspection" | "awaitingRework";

export function InspectionQueue({ rows, canInspect }: { rows: InspectionItem[]; canInspect: boolean }) {
  return rows.length === 0 ? (
    <EmptyState
      title="Nothing is waiting on an inspector"

    />
  ) : (
    <div className="space-y-4">
      {rows.map((row) => (
        <InspectionCard key={row.operationId} row={row} canInspect={canInspect} />
      ))}
    </div>
  );
}

function InspectionCard({ row, canInspect }: { row: InspectionItem; canInspect: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [source, setSource] = useState<Source>(
    row.pendingInspection > 0 ? "pendingInspection" : "awaitingRework"
  );
  const available = source === "pendingInspection" ? row.pendingInspection : row.awaitingRework;
  const [qty, setQty] = useState(available);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<Verdict | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  // Kept per verdict so a retry after a lost response replays rather than
  // inspecting the same units a second time.
  const commands = useRef(new Map<string, string>());

  function submit(verdict: Verdict) {
    if (pending) return;
    const clamped = Math.max(1, Math.min(qty || 0, available));
    if (verdict === "SCRAP" && !reason.trim()) {
      setMessage({ error: true, text: "Say why it is being scrapped — it is the only record." });
      return;
    }
    const key = `${verdict}:${source}:${clamped}`;
    const commandId = commands.current.get(key) ?? crypto.randomUUID();
    commands.current.set(key, commandId);
    setBusy(verdict);
    startTransition(async () => {
      try {
        const res = await recordInspection({
          operationId: row.operationId,
          commandId,
          quantity: clamped,
          verdict,
          from: source,
          requirementId: row.requirementId,
          reason: reason.trim() || undefined,
        });
        if (!res.ok) {
          setMessage({ error: true, text: res.error });
          return;
        }
        commands.current.delete(key);
        setMessage({
          error: false,
          text:
            verdict === "PASS"
              ? res.allocated > 0
                ? `${clamped} passed — ${res.allocated} handed to ${row.waitingOperationName ?? "the waiting step"}.`
                : `${clamped} passed.`
              : verdict === "REWORK"
                ? `${clamped} sent for rework.`
                : `${clamped} scrapped.`,
        });
        setReason("");
        router.refresh();
      } catch {
        setMessage({
          error: true,
          text: "No confirmation received. Retry safely — it will not inspect twice.",
        });
      } finally {
        setBusy(null);
      }
    });
  }

  const shortfall =
    row.requiredQuantity !== null ? Math.max(0, row.requiredQuantity - row.satisfied) : 0;

  return (
    <Panel className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-gray-900">
            {row.itemName} <span className="font-mono text-xs text-gray-400">{row.sku}</span>
          </p>
          <p className="mt-0.5 text-sm text-gray-500">
            {row.operationName} · {row.stationName ?? "No station"} ·{" "}
            <Link
              href={`/orders/${row.orderId}`}
              className="underline-offset-2 hover:text-primary-600 hover:underline"
            >
              {row.orderNumber}
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {row.pendingInspection > 0 && (
            <Chip tone="alert">{row.pendingInspection} awaiting inspection</Chip>
          )}
          {row.awaitingRework > 0 && <Chip tone="quiet">{row.awaitingRework} for rework</Chip>}
        </div>
      </div>

      {/* The cost of leaving it in the queue, stated rather than implied. */}
      {row.waitingOperationName && shortfall > 0 && (
        <p className="mt-3 rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">
          Holding up <strong>{row.waitingOperationName}</strong> on {row.waitingOrderNumber} —
          short {shortfall}.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          ["Awaiting inspection", row.pendingInspection],
          ["For rework", row.awaitingRework],
          ["Accepted", row.accepted],
          ["Scrapped", row.scrapped],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-gray-500">{label}</dt>
            <dd className="tnum mt-1 font-semibold text-gray-900">{value}</dd>
          </div>
        ))}
      </dl>

      {canInspect ? (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="flex flex-wrap items-end gap-3">
            {row.pendingInspection > 0 && row.awaitingRework > 0 && (
              <label className="text-sm text-gray-600">
                Inspecting
                <select
                  className="mt-1 block min-h-11 rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3"
                  value={source}
                  onChange={(e) => {
                    const next = e.target.value as Source;
                    setSource(next);
                    setQty(next === "pendingInspection" ? row.pendingInspection : row.awaitingRework);
                  }}
                >
                  <option value="pendingInspection">New output ({row.pendingInspection})</option>
                  <option value="awaitingRework">Reworked ({row.awaitingRework})</option>
                </select>
              </label>
            )}

            <label className="text-sm text-gray-600">
              Quantity
              <input
                type="number"
                min={1}
                max={available}
                className="tnum mt-1 block min-h-11 w-28 rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3"
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
              />
            </label>

            <label className="min-w-52 flex-1 text-sm text-gray-600">
              Reason <span className="text-gray-400">(required to scrap)</span>
              <input
                className="mt-1 block min-h-11 w-full rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Bowed skin, out of flatness"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button tone="primary" disabled={pending || available < 1} onClick={() => submit("PASS")}>
              {busy === "PASS" ? "Passing…" : "Pass"}
            </Button>
            {source === "pendingInspection" && (
              <Button disabled={pending || available < 1} onClick={() => submit("REWORK")}>
                {busy === "REWORK" ? "Sending…" : "Send for rework"}
              </Button>
            )}
            <Button disabled={pending || available < 1} onClick={() => submit("SCRAP")}>
              {busy === "SCRAP" ? "Scrapping…" : "Scrap"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-4 border-t border-gray-100 pt-3 text-sm text-gray-500">
          Read-only. A supervisor records the verdict.
        </p>
      )}

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-3 text-sm ${message.error ? "text-danger-700" : "text-success-700"}`}
        >
          {message.text}
        </p>
      )}
    </Panel>
  );
}
