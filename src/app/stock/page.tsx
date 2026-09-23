import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { inventoryBalances } from "@/db/schema";
import { lotsFor } from "@/lib/inventory";
import { Panel, PageHeader, SectionHeading, Stat, Chip, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Finished units on the rack.
 *
 * Separate from Inventory on purpose: a buyer looking for copper tube and a
 * despatcher looking for a built machine are two different people asking two
 * different questions, and one list answers neither well.
 *
 * A unit arrives here when its last step is signed off — the batch number is its
 * order number, which is what a customer quotes on the phone.
 */
export default async function StockPage() {
  const balances = (
    await db.query.inventoryBalances.findMany({
      with: { item: true, location: true },
      orderBy: [asc(inventoryBalances.id)],
    })
  ).filter((b) => b.item.isFinishedGood);

  const rows = (
    await Promise.all(
      balances.map(async (b) => {
        const { lots, unlottedRemaining } = await lotsFor(b.itemId, b.locationId);
        return {
          id: b.id,
          itemName: b.item.name,
          sku: b.item.sku,
          locationName: b.location.name,
          available: b.onHand - b.activeReserved - b.heldQty,
          onHand: b.onHand,
          lots: lots.filter((l) => l.remaining > 0),
          unlotted: unlottedRemaining,
        };
      })
    )
    // A location keeps its balance row at zero once everything has shipped. That is
    // right for the ledger and wrong for a rack: nothing is standing there.
  ).filter((r) => r.onHand > 0);

  const totalUnits = rows.reduce((s, r) => s + r.onHand, 0);
  const products = new Set(rows.map((r) => r.sku)).size;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Finished goods"
        title="Stock"
        subtitle="Built units waiting to go out."
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Stat label="Units on the rack" value={totalUnits} note="Built and not yet loaded" />
        <Stat label="Different products" value={products} />
      </div>

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Nothing built yet"

          />
        </div>
      ) : (
        <>
          <SectionHeading note={`${rows.length} ${rows.length === 1 ? "line" : "lines"}`}>
            On the rack
          </SectionHeading>
          <Panel className="mt-3 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/70 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 font-medium">Where</th>
                  <th className="px-4 py-2 font-medium">Built as</th>
                  <th className="px-4 py-2 text-right font-medium">Free</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-gray-900">{r.itemName}</span>
                      <span className="ml-2 text-xs text-gray-400">{r.sku}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{r.locationName}</td>
                    <td className="px-4 py-2.5">
                      {r.lots.length === 0 ? (
                        <span className="text-xs text-gray-400">No batch recorded</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {r.lots.map((l) => (
                            <Chip key={l.lotId} tone="neutral">
                              {l.batchNumber ?? "—"} · {l.remaining}
                            </Chip>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right font-medium text-gray-900">
                      {r.available}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      <p className="mt-6 text-sm text-gray-500">
        Materials and bought-in parts are on{" "}
        <Link href="/inventory" className="underline">
          Inventory
        </Link>
        .
      </p>
    </div>
  );
}
