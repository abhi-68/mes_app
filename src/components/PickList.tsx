"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanInput } from "@/components/ScanInput";
import { pickMaterial, pickUnlabelled, scrapMaterialAtStep, type PickLine } from "@/app/actions/picking";
import { Button, Chip } from "@/components/ui";

export type ScrapReason = { id: number; label: string };

/**
 * Go and get these.
 *
 * Starting a step commits the material; this is where it physically leaves the
 * shelf. The handler scans the batch in their hands, which is the only moment
 * anybody actually knows which pallet was taken — so it is the only moment the
 * system is entitled to write one down.
 */
export function PickList({
  operationId,
  lines,
  scrapReasons = [],
}: {
  operationId: number;
  lines: PickLine[];
  /** Empty hides the write-off action — a screen with no reasons to offer. */
  scrapReasons?: ScrapReason[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<PickLine | null>(null);
  const [scrapping, setScrapping] = useState<PickLine | null>(null);
  const [scrapQty, setScrapQty] = useState(1);
  const [scrapReason, setScrapReason] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const command = useRef<string | null>(null);

  const outstanding = lines.filter((l) => l.outstanding > 0);
  if (lines.length === 0) return null;

  /* Material already on the bench, found unusable. The step goes short again by
     itself — readiness subtracts WIP scrap — so there is nothing else to press. */
  function reject(
    line: PickLine,
    reasonCodeId: number,
    qty: number,
    batchNumber: string | null
  ) {
    if (pending) return;
    const commandId = command.current ?? crypto.randomUUID();
    command.current = commandId;
    startTransition(async () => {
      const res = await scrapMaterialAtStep({
        commandId,
        operationId,
        requirementId: line.requirementId,
        quantity: qty,
        reasonCodeId,
        batchNumber,
        note: null,
      });
      if (!res.ok) {
        setMessage({ error: true, text: res.error });
        return;
      }
      command.current = null;
      setScrapping(null);
      setScrapReason(null);
      setMessage({
        error: false,
        text: `Wrote off ${res.result.scrapped} ${line.unit} of ${line.itemName}. Collect a replacement.`,
      });
      router.refresh();
    });
  }

  function take(line: PickLine, batchNumber: string, qty: number) {
    if (pending) return;
    const commandId = command.current ?? crypto.randomUUID();
    command.current = commandId;
    startTransition(async () => {
      const res = await pickMaterial({
        commandId,
        operationId,
        requirementId: line.requirementId,
        batchNumber,
        quantity: qty,
      });
      if (!res.ok) {
        setMessage({ error: true, text: res.error });
        return;
      }
      command.current = null;
      setTarget(null);
      setMessage({
        error: false,
        text:
          `Took ${res.result.taken} from ${res.result.batchNumber}.` +
          (res.result.outstanding > 0
            ? ` ${res.result.outstanding} ${line.unit} still to get.`
            : ` ${line.itemName} is complete.`),
      });
      router.refresh();
    });
  }

  function takeUnlabelled(line: PickLine, qty: number) {
    if (pending) return;
    const commandId = command.current ?? crypto.randomUUID();
    command.current = commandId;
    startTransition(async () => {
      const res = await pickUnlabelled({
        commandId,
        operationId,
        requirementId: line.requirementId,
        quantity: qty,
      });
      if (!res.ok) {
        setMessage({ error: true, text: res.error });
        return;
      }
      command.current = null;
      setTarget(null);
      setMessage({
        error: false,
        text:
          `Took ${res.result.taken} with no label.` +
          (res.result.outstanding > 0
            ? ` ${res.result.outstanding} ${line.unit} still to get.`
            : ` ${line.itemName} is complete.`),
      });
      router.refresh();
    });
  }

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-800">
          {outstanding.length === 0 ? "Materials collected" : "Collect these"}
        </p>
        {outstanding.length === 0 && <Chip tone="neutral">All here</Chip>}
      </div>

      <ul className="mt-2 space-y-2">
        {lines.map((line) => {
          const done = line.outstanding === 0;
          return (
            <li key={line.requirementId} className="text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={done ? "text-gray-500" : "text-gray-900"}>
                  {line.itemName}
                  <span className="tnum ml-2 text-xs text-gray-400">
                    {line.taken}/{line.required} {line.unit}
                  </span>
                  {line.fromSubAssembly > 0 && (
                    <span className="ml-2 text-xs text-gray-400">
                      {line.fromSubAssembly} from a sub-assembly
                    </span>
                  )}
                </span>

                {done ? (
                  <div className="flex items-center gap-2">
                    <Chip tone="neutral">Got it</Chip>
                    {line.taken > 0 && scrapReasons.length > 0 && (
                      <Button
                        tone="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setScrapping(
                            scrapping?.requirementId === line.requirementId ? null : line
                          );
                          setScrapQty(1);
                          setMessage(null);
                          command.current = null;
                        }}
                      >
                        Scrap it
                      </Button>
                    )}
                  </div>
                ) : target?.requirementId === line.requirementId ? (
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setTarget(null);
                      setMessage(null);
                    }}
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setTarget(line);
                      setQuantity(line.outstanding);
                      setMessage(null);
                      command.current = null;
                    }}
                  >
                    Scan to take {line.outstanding}
                  </Button>
                )}
              </div>

              {target?.requirementId === line.requirementId && (
                <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-end gap-2">
                    <label className="text-xs text-gray-500">
                      How many
                      <input
                        type="number"
                        min={1}
                        max={line.outstanding}
                        value={quantity}
                        onChange={(e) => setQuantity(Number(e.target.value))}
                        className="tnum mt-1 block min-h-11 w-24 rounded-lg ring-1 ring-inset ring-gray-300 px-3 text-sm"
                      />
                    </label>
                    <p className="pb-2 text-xs text-gray-400">
                      then scan the batch label on the pallet you are taking
                    </p>
                  </div>
                  <ScanInput
                    autoFocus
                    label={`Batch for ${line.itemName}`}
                    placeholder="Scan the batch label"
                    onScan={(code) =>
                      take(line, code, Math.max(1, Math.min(quantity || 0, line.outstanding)))
                    }
                  />

                  {/* Opening balances and stock counts have no batch behind them.
                      Recorded as unconfirmed rather than blamed on a pallet nobody
                      looked at. */}
                  <Button
                    tone="ghost"
                    size="sm"
                    disabled={pending}
                    className="mt-2"
                    onClick={() =>
                      takeUnlabelled(
                        line,
                        Math.max(1, Math.min(quantity || 0, line.outstanding))
                      )
                    }
                  >
                    No label on it
                  </Button>
                </div>
              )}

              {scrapping?.requirementId === line.requirementId && (
                <div className="mt-2 rounded-lg bg-danger-50 p-3 ring-1 ring-inset ring-danger-600/20">
                  <p className="text-xs font-medium text-danger-700">
                    Writing off material already out on this job. What is wrong with it?
                  </p>
                  <label className="mt-2 block text-xs text-gray-600">
                    How many of {line.taken} {line.unit}
                    <input
                      type="number"
                      min={1}
                      max={line.taken}
                      value={scrapQty}
                      onChange={(e) => setScrapQty(Number(e.target.value))}
                      className="tnum mt-1 block min-h-11 w-24 rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-gray-300"
                    />
                  </label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {scrapReasons.map((r) => (
                      <Button
                        key={r.id}
                        tone={scrapReason === r.id ? "danger" : "secondary"}
                        size="sm"
                        disabled={pending}
                        onClick={() => setScrapReason(r.id)}
                      >
                        {r.label}
                      </Button>
                    ))}
                  </div>

                  {scrapReason !== null && (
                    <div className="mt-3 rounded-lg bg-white p-3">
                      <ScanInput
                        autoFocus
                        label={`Batch being written off (${line.itemName})`}
                        placeholder="Scan the batch label"
                        onScan={(code) =>
                          reject(
                            line,
                            scrapReason,
                            Math.max(1, Math.min(scrapQty || 0, line.taken)),
                            code
                          )
                        }
                      />
                      {/* Oldest-first would be a guess. An unscanned write-off is
                          recorded with no batch, which reads as "not known". */}
                      <Button
                        tone="ghost"
                        size="sm"
                        disabled={pending}
                        className="mt-2"
                        onClick={() =>
                          reject(
                            line,
                            scrapReason,
                            Math.max(1, Math.min(scrapQty || 0, line.taken)),
                            null
                          )
                        }
                      >
                        No label on it
                      </Button>
                    </div>
                  )}

                  <div className="mt-3">
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setScrapping(null);
                        setScrapReason(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-2 text-sm ${message.error ? "text-danger-700" : "text-success-700"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
