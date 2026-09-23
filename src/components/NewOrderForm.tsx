"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMadeToOrder } from "@/app/actions/admin";
import { CustomerField } from "@/components/CustomerField";
import { DrawingField, attachDrawing } from "@/components/DrawingField";
import { Button, Panel } from "@/components/ui";

type Option = { id: number; label: string };

const input =
  "mt-1 min-h-11 w-full rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3 text-sm";

/**
 * Raise an order for something that has never been built.
 *
 * Made to order means the drawing arrives with the purchase order, so "pick a
 * product" is a dead end — the product is what you are about to describe. Name it,
 * list what it is made of, list the steps, done.
 */
export type ProductSpec = {
  id: number;
  label: string;
  materials: { itemId: number; quantity: number; stepIndex: number }[];
  steps: { name: string; stationId: number | null; instructions?: string | null }[];
};

export function NewOrderForm({
  customers,
  parts,
  stations,
  workTypes,
}: {
  customers: Option[];
  parts: Option[];
  stations: Option[];
  /** The kinds of work this shop does, for the step dropdown. */
  workTypes: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState<number | null>(customers[0]?.id ?? null);
  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [dueDate, setDueDate] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [materialType, setMaterialType] = useState("");
  const [drawing, setDrawing] = useState<File | null>(null);

  const [materials, setMaterials] = useState<
    { itemId: number; quantity: number; stepIndex: number }[]
  >([{ itemId: parts[0]?.id ?? 0, quantity: 1, stepIndex: 0 }]);
  const [steps, setSteps] = useState<
    { name: string; stationId: number | null; instructions: string }[]
  >([{ name: "", stationId: stations[0]?.id ?? null, instructions: "" }]);

  function submit() {
    if (pending) return;
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await createMadeToOrder({
        customerId,
        productName,
        sku,
        quantity,
        dueDate: dueDate || null,
        dimensions: dimensions.trim() || null,
        materialType: materialType.trim() || null,
        materials,
        steps,
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
      // Go to the order that was just raised. Clearing the form and staying put
      // looks the same as nothing happening, and the next thing anyone wants is
      // to see the steps it created.
      setDone(`${res.orderNumber} raised.`);
      router.push(`/orders/${res.orderId}`);
    });
  }

  return (
    <Panel className="p-5">
      <h2 className="text-sm font-semibold text-gray-950">Something we have never built</h2>
      <p className="mt-0.5 mb-4 text-sm text-gray-500">
        Describe it once here and it becomes a product you can reorder.
      </p>

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">What are we building?</span>
          <input
            className={input}
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="Gear Rack Assembly Grade 002"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Part number</span>
          <input
            className={`${input} tnum`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="auto"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">How many</span>
          <input
            type="number"
            min={1}
            className={`${input} tnum`}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
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

      {/* --- Bill of materials --- */}
      <div className="mt-6">
        <p className="text-sm font-medium text-gray-800">Materials for one unit, and where they are used</p>
        <div className="mt-2 space-y-2">
          {materials.map((m, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="min-w-56 flex-1">
                <select
                  className={input}
                  value={m.itemId}
                  onChange={(e) =>
                    setMaterials((old) =>
                      old.map((x, j) => (j === i ? { ...x, itemId: Number(e.target.value) } : x))
                    )
                  }
                >
                  {parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="number"
                min={1}
                aria-label="Quantity per unit"
                className={`${input} tnum w-24`}
                value={m.quantity}
                onChange={(e) =>
                  setMaterials((old) =>
                    old.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x))
                  )
                }
              />
              <label className="min-w-40">
                <select
                  aria-label="Used at which step"
                  className={input}
                  value={m.stepIndex}
                  onChange={(e) =>
                    setMaterials((old) =>
                      old.map((x, j) =>
                        j === i ? { ...x, stepIndex: Number(e.target.value) } : x
                      )
                    )
                  }
                >
                  {steps.map((s, k) => (
                    <option key={k} value={k}>
                      {s.name.trim() || "Step not chosen yet"}
                    </option>
                  ))}
                </select>
              </label>
              <Button onClick={() => setMaterials((old) => old.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-2">
          <Button
            onClick={() =>
              setMaterials((old) => [
                ...old,
                { itemId: parts[0]?.id ?? 0, quantity: 1, stepIndex: 0 },
              ])
            }
          >
            Add material
          </Button>
        </div>
      </div>

      {/* --- Routing --- */}
      <div className="mt-6">
        <p className="text-sm font-medium text-gray-800">Steps, in order</p>
        <div className="mt-2 space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="min-w-52 flex-1">
                <select
                  aria-label="Type of work"
                  className={input}
                  value={workTypes.includes(s.name) ? s.name : s.name ? "__other" : ""}
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, j) =>
                        j === i
                          ? { ...x, name: e.target.value === "__other" ? " " : e.target.value }
                          : x
                      )
                    )
                  }
                >
                  <option value="">Type of work…</option>
                  {workTypes.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                  <option value="__other">Something else…</option>
                </select>
                {!workTypes.includes(s.name) && s.name !== "" && (
                  <input
                    className={input}
                    value={s.name.trim()}
                    onChange={(e) =>
                      setSteps((old) =>
                        old.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))
                      )
                    }
                    placeholder="Name the work"
                  />
                )}
              </label>
              <label className="min-w-44">
                <select
                  className={input}
                  value={s.stationId ?? ""}
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, j) =>
                        j === i
                          ? { ...x, stationId: e.target.value ? Number(e.target.value) : null }
                          : x
                      )
                    )
                  }
                >
                  <option value="">Any station</option>
                  {stations.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button onClick={() => setSteps((old) => old.filter((_, j) => j !== i))}>
                Remove
              </Button>
              {/* The spec for THIS operation. It follows the job to the bench, so a
                  cut list stays at the saw instead of on the unit's front page. */}
              <label className="w-full">
                <span className="text-xs text-gray-500">What to do at this step</span>
                <input
                  className={input}
                  value={s.instructions}
                  placeholder="Cut to 2400 × 1200, deburr all edges"
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x))
                    )
                  }
                />
              </label>
            </div>
          ))}
        </div>
        <div className="mt-2">
          <Button
            onClick={() =>
              setSteps((old) => [
                ...old,
                { name: "", stationId: stations[0]?.id ?? null, instructions: "" },
              ])
            }
          >
            Add step
          </Button>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button tone="primary" disabled={pending || !productName.trim()} onClick={submit}>
          {pending ? "Creating…" : "Create order"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-success-700">
            {done}
          </p>
        )}
      </div>
    </Panel>
  );
}
