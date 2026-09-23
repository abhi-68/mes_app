"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { receiveDelivery } from "@/app/actions/admin";
import { Button, Panel } from "@/components/ui";
import { BarcodeLabel } from "@/components/BarcodeLabel";

export type ReceiveOption = { id: number; label: string; unit: string };

/**
 * Booking a delivery in.
 *
 * The heat number is first and prominent on purpose. It is the field that is easy
 * to skip on a busy bench and impossible to add afterwards — once the pallet is
 * unwrapped and the certificate is in a drawer, that lot is permanently anonymous.
 * Everything else here can be corrected later; that one cannot.
 */
export function ReceiveForm({
  items,
  locations,
  vendors,
}: {
  items: ReceiveOption[];
  locations: { id: number; label: string }[];
  vendors: { id: number; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState<number | null>(items[0]?.id ?? null);
  const [locationId, setLocationId] = useState<number | null>(locations[0]?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [heatNumber, setHeatNumber] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [procurementReference, setProcurementReference] = useState("");
  const [storageLocation, setStorageLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Kept after a successful receipt so the label can be printed straight away,
  // which is the only moment anyone will actually do it.
  const [lastLabel, setLastLabel] = useState<{
    code: string;
    itemName: string;
    heatNumber: string;
    quantity: number;
    unit: string;
    storageLocation: string;
  } | null>(null);

  const item = items.find((i) => i.id === itemId);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)} tone="primary">
          Book a delivery in
        </Button>
        {lastLabel && (
          <span className="text-sm text-gray-500">
            Last received: <span className="tnum font-medium">{lastLabel.code}</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <Panel className="px-5 py-4">
      <p className="text-sm font-medium text-gray-700">Book a delivery in</p>
      <p className="mt-1 text-xs text-gray-500">
        Record the heat number now — once the certificate is filed it cannot be tied back.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Item">
          <select
            value={itemId ?? ""}
            onChange={(e) => setItemId(Number(e.target.value))}
            className={selectClass}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
          <Link
            href="/admin/products"
            className="mt-1 inline-block text-xs text-gray-500 underline"
          >
            Not on the list? Add it
          </Link>
        </Field>

        <Field label={`Quantity${item ? ` (${item.unit})` : ""}`}>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className={`${inputClass} tabular-nums`}
          />
        </Field>

        <Field label="Heat number (from the mill cert)">
          <input
            value={heatNumber}
            onChange={(e) => setHeatNumber(e.target.value)}
            placeholder="e.g. EB7728"
            className={`${inputClass} font-mono`}
          />
        </Field>

        <Field label="Batch number (left blank, one is generated)">
          <input
            value={batchNumber}
            onChange={(e) => setBatchNumber(e.target.value)}
            placeholder="e.g. 307290-4"
            className={`${inputClass} font-mono`}
          />
        </Field>

        <Field label="Location">
          <select
            value={locationId ?? ""}
            onChange={(e) => setLocationId(Number(e.target.value))}
            className={selectClass}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Where it sits">
          <input
            value={storageLocation}
            onChange={(e) => setStorageLocation(e.target.value)}
            placeholder="e.g. IN Bay 01"
            className={inputClass}
          />
        </Field>

        <Field label="Vendor">
          <select
            value={vendorId ?? ""}
            onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : null)}
            className={selectClass}
          >
            <option value="">Not recorded</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="PO / delivery reference">
          <input
            value={procurementReference}
            onChange={(e) => setProcurementReference(e.target.value)}
            placeholder="e.g. 260750"
            className={`${inputClass} font-mono`}
          />
        </Field>
      </div>

      {error && <p className="mt-3 text-sm text-danger-700">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="lg"
          disabled={pending || !itemId || !locationId}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await receiveDelivery({
                itemId: itemId!,
                locationId: locationId!,
                quantity,
                heatNumber,
                batchNumber,
                vendorId,
                procurementReference,
                storageLocation,
              });
              if (!res.ok) {
                setError(res.error);
                return;
              }
              setLastLabel({
                code: res.batchNumber ?? "",
                itemName: item?.label ?? "",
                heatNumber,
                quantity,
                unit: item?.unit ?? "",
                storageLocation,
              });
              setHeatNumber("");
              setBatchNumber("");
              setProcurementReference("");
            });
          }}
        >
          {pending ? "Booking in…" : "Receive"}
        </Button>
        <Button size="lg" tone="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>

      {lastLabel && (
        <div className="mt-5 border-t border-gray-200 pt-4">
          <p className="text-sm font-medium text-gray-700">Label for the pallet</p>
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <BarcodeLabel
              code={lastLabel.code}
              itemName={lastLabel.itemName}
              heatNumber={lastLabel.heatNumber || null}
              quantity={lastLabel.quantity}
              unit={lastLabel.unit}
              storageLocation={lastLabel.storageLocation || null}
            />
            <Button tone="secondary" onClick={() => window.print()}>
              Print
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

const inputClass =
  "mt-1 min-h-11 w-full rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3 text-sm";
const selectClass = inputClass;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      {children}
    </label>
  );
}
