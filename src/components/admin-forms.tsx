"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  createStation,
  createItem,
  addRoutingStep,
  deleteRoutingStep,
  moveRoutingStep,
  addBomLine,
  deleteBomLine,
  createUser,
  setUserActive,
  createReasonCode,
  setReasonCodeActive,
} from "@/app/actions/admin";
import { Button } from "@/components/ui";

type Result = { ok: true } | { ok: false; error: string };

function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = (fn: () => Promise<Result>, onSuccess?: () => void) => {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error);
      else {
        setDone(true);
        onSuccess?.();
        setTimeout(() => setDone(false), 2500);
      }
    });
  };

  return { pending, error, done, run };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-steel-500">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-md border border-steel-300 bg-white px-3 text-sm min-h-11 placeholder:text-steel-400";

function Feedback({ error, done, doneText }: { error: string | null; done: boolean; doneText: string }) {
  if (error) return <p className="mt-2 text-sm text-blocked-fg">{error}</p>;
  if (done) return <p className="mt-2 text-sm text-ok-fg">{doneText}</p>;
  return null;
}

/* ----------------------------- Stations ----------------------------- */

export function NewStationForm() {
  const { pending, error, done, run } = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <Field label="Station name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Powder Coat"
          className={inputClass}
        />
      </Field>
      <Field label="What happens here">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
          className={inputClass}
        />
      </Field>
      <Button
        disabled={pending}
        onClick={() => run(() => createStation(name, description), () => { setName(""); setDescription(""); })}
      >
        Add station
      </Button>
      <div className="sm:col-span-3">
        <Feedback error={error} done={done} doneText="Station added." />
      </div>
    </div>
  );
}

/* ------------------------------- Items ------------------------------- */

export function NewItemForm() {
  const { pending, error, done, run } = useAction();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [procurementType, setProcurementType] = useState<"MANUFACTURED" | "PURCHASED">(
    "MANUFACTURED"
  );
  const [isFinishedGood, setIsFinishedGood] = useState(false);
  const [unitOfMeasure, setUnitOfMeasure] = useState("ea");
  const [openingStock, setOpeningStock] = useState(0);
  const [reorderPoint, setReorderPoint] = useState(0);

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="SKU">
          <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SUB-DAMPER-01" className={inputClass} />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Damper Section" className={inputClass} />
        </Field>
        <Field label="Where it comes from">
          <select
            value={procurementType}
            onChange={(e) => setProcurementType(e.target.value as "MANUFACTURED" | "PURCHASED")}
            className={inputClass}
          >
            <option value="MANUFACTURED">Made here (gets its own steps)</option>
            <option value="PURCHASED">Bought in (consumed from stock)</option>
          </select>
        </Field>
        <Field label="Unit">
          <input value={unitOfMeasure} onChange={(e) => setUnitOfMeasure(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Opening stock">
          <input type="number" min={0} value={openingStock} onChange={(e) => setOpeningStock(Number(e.target.value))} className={`${inputClass} tabular-nums`} />
        </Field>
        <Field label="Reorder at">
          <input type="number" min={0} value={reorderPoint} onChange={(e) => setReorderPoint(Number(e.target.value))} className={`${inputClass} tabular-nums`} />
        </Field>
      </div>
      <label className="mt-3 flex min-h-11 items-center gap-2.5 text-sm text-steel-600">
        <input
          type="checkbox"
          checked={isFinishedGood}
          onChange={(e) => setIsFinishedGood(e.target.checked)}
          className="h-6 w-6 rounded border-steel-300"
        />
        This is a finished product we sell
      </label>
      <div className="mt-3">
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () =>
                createItem({
                  sku,
                  name,
                  procurementType,
                  isFinishedGood,
                  unitOfMeasure,
                  openingStock,
                  reorderPoint,
                }),
              () => {
                setSku("");
                setName("");
                setOpeningStock(0);
                setReorderPoint(0);
              }
            )
          }
        >
          Add product
        </Button>
        <Feedback error={error} done={done} doneText="Product added." />
      </div>
    </div>
  );
}

/* ----------------------------- Routing ------------------------------ */

export function RoutingEditor({
  itemId,
  steps,
  stations,
}: {
  itemId: number;
  steps: { id: number; sequence: number; name: string; stationName: string | null; expectedMinutes: number | null }[];
  stations: { id: number; name: string }[];
}) {
  const { pending, error, done, run } = useAction();
  const [name, setName] = useState("");
  const [stationId, setStationId] = useState<number | null>(stations[0]?.id ?? null);
  const [minutes, setMinutes] = useState<number | "">("");

  return (
    <div>
      <ol className="divide-y divide-steel-100 rounded-lg border border-steel-200 bg-white">
        {steps.length === 0 && (
          <li className="px-5 py-6 text-center text-sm text-steel-400">
            No steps yet. Add the first one below — this is the process for this product.
          </li>
        )}
        {steps.map((s, i) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <span className="w-5 text-right text-xs tabular-nums text-steel-400">{i + 1}</span>
              <div>
                <p className="text-sm text-steel-900">{s.name}</p>
                <p className="text-xs text-steel-400">
                  {s.stationName ?? "Unassigned"}
                  {s.expectedMinutes ? ` · ${s.expectedMinutes} min estimated` : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" tone="ghost" disabled={pending || i === 0} onClick={() => run(() => moveRoutingStep(s.id, -1))}>
                Up
              </Button>
              <Button size="sm" tone="ghost" disabled={pending || i === steps.length - 1} onClick={() => run(() => moveRoutingStep(s.id, 1))}>
                Down
              </Button>
              <Button size="sm" tone="ghost" disabled={pending} onClick={() => run(() => deleteRoutingStep(s.id))}>
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-4 grid gap-3 rounded-lg border border-steel-200 bg-steel-50 p-4 sm:grid-cols-[2fr_1fr_auto_auto] sm:items-end">
        <Field label="Next step">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Deburr edges" className={inputClass} />
        </Field>
        <Field label="Station">
          <select
            value={stationId ?? ""}
            onChange={(e) => setStationId(e.target.value ? Number(e.target.value) : null)}
            className={inputClass}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Minutes">
          <input
            type="number"
            min={0}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value === "" ? "" : Number(e.target.value))}
            className={`${inputClass} w-24 tabular-nums`}
          />
        </Field>
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () =>
                addRoutingStep({
                  itemId,
                  name,
                  stationId,
                  expectedMinutes: minutes === "" ? null : minutes,
                }),
              () => {
                setName("");
                setMinutes("");
              }
            )
          }
        >
          Add step
        </Button>
        <div className="sm:col-span-4">
          <Feedback error={error} done={done} doneText="Step added." />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- BOM -------------------------------- */

export function BomEditor({
  parentItemId,
  lines,
  allItems,
  steps,
}: {
  parentItemId: number;
  lines: { id: number; componentName: string; componentSku: string; quantity: number; consumedAtStepName: string | null }[];
  allItems: { id: number; name: string; sku: string }[];
  steps: { id: number; name: string }[];
}) {
  const { pending, error, done, run } = useAction();
  const [componentItemId, setComponentItemId] = useState<number | null>(allItems[0]?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [stepId, setStepId] = useState<number | null>(steps[0]?.id ?? null);

  return (
    <div>
      <div className="divide-y divide-steel-100 rounded-lg border border-steel-200 bg-white">
        {lines.length === 0 && (
          <p className="px-5 py-6 text-center text-sm text-steel-400">
            Nothing listed yet. Add what this product is built from.
          </p>
        )}
        {lines.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div>
              <p className="text-sm text-steel-900">
                <span className="tabular-nums">{l.quantity}×</span> {l.componentName}
              </p>
              <p className="text-xs text-steel-400">
                {l.componentSku}
                {l.consumedAtStepName
                  ? ` · taken from stock at "${l.consumedAtStepName}"`
                  : " · taken from stock when the order finishes"}
              </p>
            </div>
            <Button size="sm" tone="ghost" disabled={pending} onClick={() => run(() => deleteBomLine(l.id))}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border border-steel-200 bg-steel-50 p-4 sm:grid-cols-[2fr_auto_2fr_auto] sm:items-end">
        <Field label="Component">
          <select
            value={componentItemId ?? ""}
            onChange={(e) => setComponentItemId(e.target.value ? Number(e.target.value) : null)}
            className={inputClass}
          >
            {allItems.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.sku})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Qty">
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className={`${inputClass} w-20 tabular-nums`}
          />
        </Field>
        <Field label="Taken from stock at">
          <select
            value={stepId ?? ""}
            onChange={(e) => setStepId(e.target.value ? Number(e.target.value) : null)}
            className={inputClass}
          >
            <option value="">When the order finishes</option>
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={pending || componentItemId === null}
          onClick={() =>
            run(() =>
              addBomLine({
                parentItemId,
                componentItemId: componentItemId!,
                quantity,
                consumedAtRoutingStepId: stepId,
              })
            )
          }
        >
          Add
        </Button>
        <div className="sm:col-span-4">
          <Feedback error={error} done={done} doneText="Component added." />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- People ------------------------------ */

export function NewUserForm({ stations }: { stations: { id: number; name: string }[] }) {
  const { pending, error, done, run } = useAction();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"WORKER" | "FORKLIFT" | "SUPERVISOR" | "ADMIN">("WORKER");
  const [stationId, setStationId] = useState<number | null>(stations[0]?.id ?? null);

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Temporary password">
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className={inputClass} />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={inputClass}>
            <option value="WORKER">Worker — sees and ticks off their own station</option>
            <option value="FORKLIFT">Forklift — loads finished goods onto trucks</option>
            <option value="SUPERVISOR">Supervisor — all stations, can correct times</option>
            <option value="ADMIN">Admin — full access including setup</option>
          </select>
        </Field>
        <Field label="Station">
          <select
            value={stationId ?? ""}
            onChange={(e) => setStationId(e.target.value ? Number(e.target.value) : null)}
            className={inputClass}
          >
            <option value="">No station</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => createUser({ name, email, password, role, stationId }),
              () => {
                setName("");
                setEmail("");
                setPassword("");
              }
            )
          }
        >
          Add person
        </Button>
        <Feedback error={error} done={done} doneText="Person added." />
      </div>
    </div>
  );
}

export function ToggleUserButton({ id, active }: { id: number; active: boolean }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" tone="ghost" disabled={pending} onClick={() => run(() => setUserActive(id, !active))}>
      {active ? "Deactivate" : "Reactivate"}
    </Button>
  );
}

/* --------------------------- Reason codes ---------------------------- */

export function NewReasonCodeForm() {
  const { pending, error, done, run } = useAction();
  const [category, setCategory] = useState<"SCRAP" | "REWORK" | "DOWNTIME" | "BLOCKED">("BLOCKED");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");

  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
      <Field label="Used for">
        <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} className={inputClass}>
          <option value="BLOCKED">Blocked</option>
          <option value="SCRAP">Scrap</option>
          <option value="REWORK">Rework</option>
          <option value="DOWNTIME">Downtime</option>
        </select>
      </Field>
      <Field label="Short code">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="WAIT_PAINT" className={inputClass} />
      </Field>
      <Field label="What people will see">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Waiting on paint booth" className={inputClass} />
      </Field>
      <Button
        disabled={pending}
        onClick={() =>
          run(
            () => createReasonCode({ category, code, label }),
            () => {
              setCode("");
              setLabel("");
            }
          )
        }
      >
        Add reason
      </Button>
      <div className="sm:col-span-4">
        <Feedback error={error} done={done} doneText="Reason added." />
      </div>
    </div>
  );
}

export function ToggleReasonButton({ id, active }: { id: number; active: boolean }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" tone="ghost" disabled={pending} onClick={() => run(() => setReasonCodeActive(id, !active))}>
      {active ? "Retire" : "Restore"}
    </Button>
  );
}
