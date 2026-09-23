"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanInput } from "@/components/ScanInput";
import { findLot, rejectStock, type ScannedLot } from "@/app/actions/stock";
import { BarcodeLabel } from "@/components/BarcodeLabel";
import { Button, Panel } from "@/components/ui";

/**
 * Scan a pallet at the rack: what is it, and is it still good?
 *
 * The scan only ever LOOKS the batch up. Writing it off is a second, deliberate
 * press with a quantity and a reason, because a barcode gun fires on a trigger
 * pull and a scan that silently removed stock would be discovered at stocktake.
 */
export function ScanAndReject() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lot, setLot] = useState<ScannedLot | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  // Held per write-off so a retry after a lost response replays rather than
  // writing the same pallet off twice.
  const command = useRef<string | null>(null);

  function look(code: string) {
    setMessage(null);
    startTransition(async () => {
      const res = await findLot(code);
      if (!res.ok) {
        setLot(null);
        setMessage({ error: true, text: res.error });
        return;
      }
      setLot(res.lot);
      setQuantity(Math.min(1, res.lot.remaining) || 1);
      setReason("");
      command.current = null;

      // Highlight it in the table below if it happens to be on this page.
      const target = document.querySelector(`[data-lot-batch="${CSS.escape(code.trim())}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function reject() {
    if (!lot || pending) return;
    const qty = Math.max(1, Math.min(quantity || 0, lot.remaining));
    if (!reason.trim()) {
      setMessage({ error: true, text: "Say what is wrong with it — it is the only record." });
      return;
    }
    const commandId = command.current ?? crypto.randomUUID();
    command.current = commandId;

    startTransition(async () => {
      const res = await rejectStock({
        commandId,
        lotId: lot.lotId,
        itemId: lot.itemId,
        locationId: lot.locationId,
        quantity: qty,
        reason: reason.trim(),
      });
      if (!res.ok) {
        setMessage({ error: true, text: res.error });
        return;
      }
      command.current = null;
      setMessage({
        error: false,
        text:
          `${qty} ${lot.unit} of ${lot.batchNumber} written off.` +
          (res.reservationsReleased > 0
            ? ` ${res.reservationsReleased} that a job had committed went with it — check Materials.`
            : ""),
      });
      setLot(null);
      setReason("");
      router.refresh();
    });
  }

  return (
    <Panel className="px-5 py-4">
      <ScanInput
        label="Scan a pallet"
        placeholder="Scan or type a batch code"
        onScan={look}
      />

      {lot && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-medium text-gray-900">
                {lot.itemName} <span className="font-mono text-xs text-gray-400">{lot.sku}</span>
              </p>
              <p className="mt-0.5 text-sm text-gray-500">
                Batch <span className="tnum font-mono">{lot.batchNumber}</span>
                {lot.heatNumber && (
                  <>
                    {" · heat "}
                    <span className="tnum font-mono">{lot.heatNumber}</span>
                  </>
                )}
              </p>
              <p className="mt-0.5 text-sm text-gray-500">
                {lot.locationName}
                {lot.storageLocation ? ` · ${lot.storageLocation}` : ""}
              </p>
              <p className="tnum mt-2 text-sm font-medium text-gray-900">
                {lot.remaining} {lot.unit} left on this batch
              </p>
            </div>
            <BarcodeLabel code={lot.batchNumber} compact />
          </div>

          {lot.remaining <= 0 ? (
            <p className="mt-3 text-sm text-gray-500">
              Nothing left on this batch — there is nothing to write off.
            </p>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-sm text-gray-600">
                  How many are damaged
                  <input
                    type="number"
                    min={1}
                    max={lot.remaining}
                    className="tnum mt-1 block min-h-11 w-28 rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3"
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </label>
                <label className="min-w-64 flex-1 text-sm text-gray-600">
                  What is wrong with it
                  <input
                    className="mt-1 block min-h-11 w-full rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Water damage in the bay, corner crushed"
                  />
                </label>
                <Button tone="primary" disabled={pending} onClick={reject}>
                  {pending ? "Writing off…" : "Write off as damaged"}
                </Button>
                <Button disabled={pending} onClick={() => setLot(null)}>
                  It is fine
                </Button>
              </div>

              <p className="mt-2.5 text-xs text-gray-400">
                This removes the units from stock for good. If a job had them committed,
                that commitment is released and the shortage shows on Materials.
              </p>
            </>
          )}
        </div>
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
