"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMadeToOrder } from "@/app/actions/admin";
import { Button, Panel } from "@/components/ui";

type Option = { id: number; label: string };

const input =
  "mt-1 min-h-11 w-full rounded-md border border-steel-300 bg-white px-3 text-sm";

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
  steps: { name: string; stationId: number | null }[];
};

export function NewOrderForm({
  customers,
  parts,
  stations,
  workTypes,
  products,
}: {
  customers: Option[];
  parts: Option[];
  stations: Option[];
  /** The kinds of work this shop does, for the step dropdown. */
  workTypes: string[];
  /** Things built before — pick one to repeat its specification. */
  products: ProductSpec[];
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

  const [materials, setMaterials] = useState<
    { itemId: number; quantity: number; stepIndex: number }[]
  >([{ itemId: parts[0]?.id ?? 0, quantity: 1, stepIndex: 0 }]);
  const [steps, setSteps] = useState<{ name: string; stationId: number | null }[]>([
    { name: "", stationId: stations[0]?.id ?? null },
  ]);

  /**
   * Repeat a product built before.
   *
   * Copies the specification, not the order: the steps and the parts list are
   * filled in and remain editable, because the second order for a thing is
   * usually the first one with something changed.
   */
  function repeat(id: number) {
    const spec = products.find((p) => p.id === id);
    if (!spec) return;
    setProductName(spec.label.replace(/\s*\([^)]*\)\s*$/, ""));
    setSku("");
    setSteps(spec.steps.length ? spec.steps : [{ name: "", stationId: stations[0]?.id ?? null }]);
    setMaterials(
      spec.materials.length
        ? spec.materials
        : [{ itemId: parts[0]?.id ?? 0, quantity: 1, stepIndex: 0 }]
    );
    setDone(null);
    setError(null);
  }

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
        materials,
        steps,
      });
      if (!res.ok) {
        setError(res.error);
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
      {products.length > 0 && (
        <label className="mb-5 block border-b border-steel-100 pb-5">
          <span className="text-xs text-steel-500">Repeat something built before</span>
          <select
            className={input}
            defaultValue=""
            onChange={(e) => e.target.value && repeat(Number(e.target.value))}
          >
            <option value="">Start from scratch</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="text-xs text-steel-500">What are we building?</span>
          <input
            className={input}
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="Gear Rack Assembly Grade 002"
          />
        </label>
        <label className="block">
          <span className="text-xs text-steel-500">Part number</span>
          <input
            className={`${input} tnum`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="auto"
          />
        </label>
        <label className="block">
          <span className="text-xs text-steel-500">How many</span>
          <input
            type="number"
            min={1}
            className={`${input} tnum`}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-steel-500">Customer</span>
          <select
            className={input}
            value={customerId ?? ""}
            onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">None</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-steel-500">Wanted by</span>
          <input
            type="date"
            className={input}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </label>
      </div>

      {/* --- Bill of materials --- */}
      <div className="mt-6">
        <p className="text-sm font-medium text-steel-800">Materials for one unit, and where they are used</p>
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
        <p className="text-sm font-medium text-steel-800">Steps, in order</p>
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
            </div>
          ))}
        </div>
        <div className="mt-2">
          <Button
            onClick={() =>
              setSteps((old) => [...old, { name: "", stationId: stations[0]?.id ?? null }])
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
          <p role="alert" className="text-sm text-blocked-fg">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-ok-fg">
            {done}
          </p>
        )}
      </div>
    </Panel>
  );
}
