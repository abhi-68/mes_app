import Link from "next/link";
import type { Shortage } from "@/lib/shortages";
import { Panel, Chip } from "@/components/ui";

/**
 * What this order cannot be built from today.
 *
 * Raising an order does not create the parts it needs. Without this the first
 * anyone hears of a shortage is a welder standing at an empty rack, by which time
 * the lead time on the missing part is running against a date already promised.
 */
export function Shortages({
  shortages,
  canBuy,
}: {
  shortages: Shortage[];
  canBuy: boolean;
}) {
  if (shortages.length === 0) {
    return (
      <Panel className="mt-4 p-5">
        <h2 className="text-sm font-semibold text-success-700">All parts in stock</h2>
      </Panel>
    );
  }

  return (
    <Panel className="mt-4 border-l-4 border-l-danger-500 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-950">
          Short {shortages.length} {shortages.length === 1 ? "item" : "items"}
        </h2>
        <Chip tone="alert">Buy before this can be built</Chip>
      </div>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="pb-1 font-medium">Part</th>
            <th className="pb-1 text-right font-medium">Needed</th>
            <th className="pb-1 text-right font-medium">Free</th>
            <th className="pb-1 text-right font-medium">Short by</th>
          </tr>
        </thead>
        <tbody>
          {shortages.map((s) => (
            <tr key={s.itemId} className="border-t border-gray-100">
              <td className="py-2">
                <span className="font-medium text-gray-900">{s.name}</span>
                <span className="ml-2 text-xs text-gray-400">{s.sku}</span>
              </td>
              <td className="tnum py-2 text-right text-gray-600">
                {s.required} {s.unit}
              </td>
              <td className="tnum py-2 text-right text-gray-600">{s.free}</td>
              <td className="tnum py-2 text-right font-semibold text-danger-700">
                {s.short}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canBuy && (
        <p className="mt-3 text-sm text-gray-500">
          Book the delivery in on{" "}
          <Link href="/inventory" className="underline">
            Inventory
          </Link>{" "}
          when it arrives and this clears itself.
        </p>
      )}
    </Panel>
  );
}
