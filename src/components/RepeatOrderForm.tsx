"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createWorkOrder } from "@/app/actions/admin";
import { CustomerField } from "@/components/CustomerField";
import { DrawingField, attachDrawing } from "@/components/DrawingField";
import { Button, Panel } from "@/components/ui";

const input =
  "mt-1 block min-h-11 w-full rounded-lg border-0 bg-white px-3 text-sm text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-primary-600";

/**
 * Order something the shop already builds.
 *
 * Distinct from the made-to-order form below it, and not a duplicate of it: that
 * one DEFINES a product, this one REUSES one. Raising the tenth CF-3000 through
 * the made-to-order form would create a tenth item with a tenth part number and
 * a tenth copy of the routing, and every report that groups by product would
 * then show ten products where the floor sees one.
 */
export function RepeatOrderForm({
  products,
  customers,
}: {
  products: { id: number; label: string }[];
  customers: { id: number; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [itemId, setItemId] = useState<number | null>(products[0]?.id ?? null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [dueDate, setDueDate] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [materialType, setMaterialType] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [drawing, setDrawing] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (products.length === 0) return null;

  function submit() {
    if (pending || itemId === null) return;
    setError(null);
    start(async () => {
      const res = await createWorkOrder({
        orderNumber: orderNumber.trim() || undefined,
        itemId: itemId!,
        customerId,
        quantity,
        dueDate: dueDate || null,
        dimensions: dimensions.trim() || null,
        materialType: materialType.trim() || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const failed = await attachDrawing(res.orderId, drawing);
      if (failed) {
        setError(failed);
        return;
      }
      router.push("/orders");
      router.refresh();
    });
  }

  return (
    <Panel className="p-5">
      <h2 className="text-sm font-semibold text-gray-950">Something we already build</h2>
      <p className="mt-0.5 text-sm text-gray-500">
        Its steps, parts list and sub-assembly orders all come from the product.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Product</span>
          <select
            className={input}
            value={itemId ?? ""}
            onChange={(e) => setItemId(Number(e.target.value))}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Quantity</span>
          <input
            type="number"
            min={1}
            className={`${input} tnum`}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Work order number</span>
          <input
            className={`${input} tnum`}
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="auto"
          />
        </label>
        <CustomerField customers={customers} value={customerId} onChange={setCustomerId} />
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Due date</span>
          <input
            type="date"
            className={input}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Size</span>
          <input
            className={input}
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="3000 CFM · 2400 × 1200 × 1800 mm"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Material</span>
          <input
            className={input}
            value={materialType}
            onChange={(e) => setMaterialType(e.target.value)}
            placeholder="304 stainless, 16ga"
          />
        </label>
        <div className="sm:col-span-4">
          <DrawingField file={drawing} onChange={setDrawing} />
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger-700">
          {error}
        </p>
      )}

      <div className="mt-4">
        <Button disabled={pending || itemId === null} onClick={submit}>
          {pending ? "Raising…" : "Create work order"}
        </Button>
      </div>
    </Panel>
  );
}
