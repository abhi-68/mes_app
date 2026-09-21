"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanInput } from "@/components/ScanInput";
import { pickMaterial, type PickLine } from "@/app/actions/picking";
import { Button, Chip } from "@/components/ui";

/**
 * Go and get these.
 *
 * Starting a step commits the material; this is where it physically leaves the
 * shelf. The handler scans the batch in their hands, which is the only moment
 * anybody actually knows which pallet was taken — so it is the only moment the
 * system is entitled to write one down.
 */
export function PickList({ operationId, lines }: { operationId: number; lines: PickLine[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<PickLine | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const command = useRef<string | null>(null);

  const outstanding = lines.filter((l) => l.outstanding > 0);
  if (lines.length === 0) return null;

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

  return (
    <div className="mt-3 rounded-lg border border-steel-200 bg-steel-50/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-steel-800">
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
                <span className={done ? "text-steel-500" : "text-steel-900"}>
                  {line.itemName}
                  <span className="tnum ml-2 text-xs text-steel-400">
                    {line.taken}/{line.required} {line.unit}
                  </span>
                  {line.fromSubAssembly > 0 && (
                    <span className="ml-2 text-xs text-steel-400">
                      {line.fromSubAssembly} from a sub-assembly
                    </span>
                  )}
                </span>

                {done ? (
                  <Chip tone="neutral">Got it</Chip>
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
                <div className="mt-2 rounded-md border border-steel-200 bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-end gap-2">
                    <label className="text-xs text-steel-500">
                      How many
                      <input
                        type="number"
                        min={1}
                        max={line.outstanding}
                        value={quantity}
                        onChange={(e) => setQuantity(Number(e.target.value))}
                        className="tnum mt-1 block min-h-11 w-24 rounded-md border border-steel-300 px-3 text-sm"
                      />
                    </label>
                    <p className="pb-2 text-xs text-steel-400">
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
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-2 text-sm ${message.error ? "text-blocked-fg" : "text-ok-fg"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
