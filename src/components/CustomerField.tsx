"use client";

import { useState, useTransition } from "react";
import { addCustomer } from "@/app/actions/admin";

const field =
  "mt-1 min-h-11 w-full rounded-md border border-gray-200 bg-white px-2.5 text-sm";

/**
 * Pick a customer, or name one that is not on the list yet.
 *
 * A first order for a new customer is the common case in a job shop, and sending
 * someone to Setup to create the customer before they can raise the order is how
 * the order ends up with no customer on it at all.
 */
export function CustomerField({
  customers,
  value,
  onChange,
}: {
  customers: { id: number; label: string }[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ id: number; label: string }[]>([]);

  const all = [...customers, ...added];

  function save() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setError(null);
    start(async () => {
      const res = await addCustomer(trimmed);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAdded((prev) => [...prev, { id: res.customer.id, label: res.customer.name }]);
      onChange(res.customer.id);
      setName("");
      setAdding(false);
    });
  }

  return (
    <div className="block sm:col-span-2">
      <span className="text-xs text-gray-500">Customer</span>
      {adding ? (
        <div className="mt-1 flex gap-2">
          <input
            autoFocus
            className={`${field} mt-0`}
            value={name}
            placeholder="Customer name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
          />
          <button
            type="button"
            disabled={pending || !name.trim()}
            onClick={save}
            className="inline-flex min-h-11 shrink-0 items-center rounded-md bg-gray-900 px-3 text-sm font-medium text-white disabled:bg-gray-200 disabled:text-gray-400"
          >
            {pending ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setName("");
              setError(null);
            }}
            className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-gray-200 px-3 text-sm text-gray-600"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-1 flex gap-2">
          <select
            className={`${field} mt-0`}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">None</option>
            {all.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-gray-200 px-3 text-sm text-gray-600 hover:bg-gray-50"
          >
            New
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
