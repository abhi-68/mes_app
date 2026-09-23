"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ScanInput } from "@/components/ScanInput";
import { lookupScan } from "@/app/actions/scan";
import { Panel } from "@/components/ui";

/**
 * Scanning a traveler at the station.
 *
 * The scan only ever *finds* the step and puts its card at the top of the page.
 * It does not start or complete anything: a barcode gun fires on a trigger pull,
 * and a mis-scan that silently clocked someone on to another order would be
 * discovered days later in the timesheets. Finding is safe to get wrong; the
 * operator still presses Start on a card that names the job.
 */
export function StationScan({ found }: { found?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onScan(code: string) {
    setError(null);
    startTransition(async () => {
      const target = await lookupScan(code);
      switch (target.kind) {
        case "operation":
          router.push(`/my-station?op=${target.operationId}`);
          break;
        case "order":
          router.push(`/orders/${target.orderId}`);
          break;
        case "lot":
          router.push(`/inventory?q=${encodeURIComponent(target.batchNumber)}`);
          break;
        default:
          setError(
            `Nothing on the floor matches “${target.code}”. Scan a traveler, a work order or a batch label.`
          );
      }
    });
  }

  return (
    <Panel className="px-5 py-4">
      <ScanInput
        onScan={onScan}
        label="Scan a traveler"
        placeholder="Scan the step, work order or batch code"
      />
      {pending && <p className="mt-2 text-sm text-gray-500">Looking it up…</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {error}
        </p>
      )}
      {found && !error && (
        <p role="status" className="mt-2 text-sm text-success-700">
          Showing {found} at the top.
        </p>
      )}
    </Panel>
  );
}
