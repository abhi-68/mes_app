import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryBalances, inventoryLocations, items, vendors } from "@/db/schema";
import { lotsFor } from "@/lib/inventory";
import { getCurrentUser, isManager } from "@/lib/session";
import { BarcodeLabel } from "@/components/BarcodeLabel";
import { ReceiveForm } from "@/components/inventory-forms";
import { ScanAndReject } from "@/components/ScanAndReject";
import { readTableQuery, sortRows, paginate } from "@/lib/table";
import { DataTable, type Column } from "@/components/DataTable";
import {
  Panel,
  PageHeader,
  SectionHeading,
  Stat,
  Chip,
} from "@/components/ui";

export default async function InventoryPage(props: PageProps<"/inventory">) {
  const sp = await props.searchParams;
  const query = readTableQuery(sp, {
    sortable: ["item", "location", "heat", "batch", "available", "storage", "received"],
  });
  const needle = query.q.toLowerCase();
  const user = await getCurrentUser();
  const manager = user ? isManager(user.role) : false;

  const balances = (
    await db.query.inventoryBalances.findMany({
      with: { item: true, location: true },
      orderBy: [asc(inventoryBalances.id)],
    })
    // Finished units have their own screen. Mixing them in here buries the copper
    // tube a buyer is looking for under the machines it went into.
  ).filter((b) => !b.item.isFinishedGood);

  // Lots per balance row, derived from the ledger. One query per row is fine at
  // this scale and is the honest shape; batching it is a change to make when a
  // real catalogue makes it necessary, not before.
  const withLots = await Promise.all(
    balances.map(async (b) => {
      const { lots, unlottedRemaining } = await lotsFor(b.itemId, b.locationId);
      return {
        id: b.id,
        item: b.item,
        locationName: b.location.name,
        onHand: b.onHand,
        reserved: b.activeReserved,
        held: b.heldQty,
        available: b.onHand - b.activeReserved - b.heldQty,
        reorderPoint: b.item.reorderPoint,
        lots: lots.filter((l) => l.remaining > 0),
        unlotted: unlottedRemaining,
      };
    })
  );


  /*
    Free stock per ITEM, summed over every batch and every location.

    A reorder point answers "do we need to buy more tube?", which is a question
    about the tube and not about one pallet or one shelf. Comparing a single row
    against it says "below" on all four pallets of a heat that between them are
    twice the threshold — and once a buyer has seen that be wrong, they stop
    reading the column.
  */
  const freeByItem = new Map<number, number>();
  const onHandByItem = new Map<number, number>();
  for (const r of withLots) {
    freeByItem.set(r.item.id, (freeByItem.get(r.item.id) ?? 0) + r.available);
    onHandByItem.set(r.item.id, (onHandByItem.get(r.item.id) ?? 0) + r.onHand);
  }

  const itemsTracked = new Map(withLots.map((r) => [r.item.id, r.item]));
  const belowReorder = [...itemsTracked.values()].filter(
    (item) => item.reorderPoint > 0 && (freeByItem.get(item.id) ?? 0) <= item.reorderPoint
  );
  const lotCount = withLots.reduce((s, r) => s + r.lots.length, 0);
  const untraceable = withLots.reduce((s, r) => s + Math.max(0, r.unlotted), 0);

  // Quantities, not counts of rows. Taking three sheets has to move a number on
  // this page, or the page looks broken to the person who just took them.
  const unitsOnHand = withLots.reduce((s, r) => s + r.onHand, 0);
  const unitsPromised = withLots.reduce((s, r) => s + r.reserved, 0);
  const unitsFree = withLots.reduce((s, r) => s + r.available, 0);

  /**
   * Searching filters the rows, never the tiles above them. "3 items below reorder
   * point" has to mean the store, not the store as narrowed by whatever is in the
   * search box, or someone reads it as all-clear.
   */

  /**
   * One row per batch, not a card per item with batches nested inside it.
   *
   * A stores person looks for a batch number, so the batch is the row. The
   * untraced remainder of an item gets a row of its own rather than being hidden,
   * because "40 on hand, 6 of them from no batch" is the fact worth seeing.
   */
  type StockRow = {
    key: string;
    itemName: string;
    sku: string;
    locationName: string;
    heatNumber: string | null;
    batchNumber: string | null;
    vendorName: string | null;
    storageLocation: string | null;
    unit: string;
    available: number;
    onHand: number;
    reserved: number;
    held: number;
    reorderPoint: number;
    /** Free stock of this ITEM everywhere, not just on this row. */
    itemFree: number;
    receivedAt: Date | null;
    traced: boolean;
  };

  const stockRows: StockRow[] = withLots.flatMap((r) => {
    const base = {
      itemName: r.item.name,
      sku: r.item.sku,
      locationName: r.locationName,
      unit: r.item.unitOfMeasure,
      onHand: r.onHand,
      reserved: r.reserved,
      held: r.held,
      reorderPoint: r.reorderPoint,
      itemFree: freeByItem.get(r.item.id) ?? 0,
    };
    const lotRows: StockRow[] = r.lots.map((l) => ({
      ...base,
      key: `lot-${l.lotId}`,
      heatNumber: l.heatNumber,
      batchNumber: l.batchNumber,
      vendorName: l.vendorName,
      storageLocation: l.storageLocation,
      available: l.remaining,
      receivedAt: l.receivedAt,
      traced: true,
    }));
    if (r.unlotted > 0) {
      lotRows.push({
        ...base,
        key: `untraced-${r.id}`,
        heatNumber: null,
        batchNumber: null,
        vendorName: null,
        storageLocation: null,
        available: r.unlotted,
        receivedAt: null,
        traced: false,
      });
    }
    return lotRows;
  });

  const counts = {
    free: stockRows.filter((r) => r.onHand - r.reserved - r.held > 0).length,
    committed: stockRows.filter((r) => r.onHand > 0 && r.onHand - r.reserved - r.held <= 0).length,
    held: stockRows.filter((r) => r.held > 0).length,
    untraced: stockRows.filter((r) => !r.traced).length,
  };

  const matched = stockRows.filter((r) => {
    if (needle) {
      const haystack =
        `${r.itemName} ${r.sku} ${r.locationName} ${r.batchNumber ?? ""} ${r.heatNumber ?? ""} ${r.vendorName ?? ""} ${r.storageLocation ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    const free = r.onHand - r.reserved - r.held;
    if (query.filter === "free") return free > 0;
    if (query.filter === "committed") return r.onHand > 0 && free <= 0;
    if (query.filter === "held") return r.held > 0;
    if (query.filter === "untraced") return !r.traced;
    return true;
  });

  const page = paginate(
    sortRows(matched, query.sort, query.dir, (r, c) =>
      c === "item" ? r.itemName
      : c === "location" ? r.locationName
      : c === "heat" ? r.heatNumber
      : c === "batch" ? r.batchNumber
      : c === "available" ? r.available
      : c === "storage" ? r.storageLocation
      : c === "received" ? r.receivedAt
      : null
    ),
    query.page,
    query.perPage
  );

  const stockColumns: Column<StockRow>[] = [
    {
      key: "item",
      label: "Item",
      sortable: true,
      render: (r) => (
        <>
          <p className="text-gray-800">{r.itemName}</p>
          <p className="tnum mt-0.5 font-mono text-xs text-gray-400">{r.sku}</p>
        </>
      ),
    },
    { key: "location", label: "Location", sortable: true, secondary: true, render: (r) => r.locationName },
    {
      key: "heat",
      label: "Heat number",
      sortable: true,
      secondary: true,
      render: (r) =>
        r.heatNumber ? (
          <span className="tnum font-mono text-xs">{r.heatNumber}</span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: "batch",
      label: "Batch number",
      sortable: true,
      render: (r) =>
        r.batchNumber ? (
          // ScanAndReject scrolls to this row by batch code, and verify-labels reads
          // the painted bars out of it.
          <div className="flex items-center gap-2" data-lot-batch={r.batchNumber}>
            <span className="tnum font-mono text-xs">{r.batchNumber}</span>
            <BarcodeLabel code={r.batchNumber} compact />
          </div>
        ) : (
          <Chip tone="quiet">No label</Chip>
        ),
    },
    { key: "uom", label: "UOM", render: (r) => <span className="text-gray-500">{r.unit}</span> },
    {
      key: "available",
      label: "Available",
      sortable: true,
      align: "right",
      render: (r) => (
        <span className="tnum font-medium text-gray-900">{r.available}</span>
      ),
    },
    {
      key: "reorder",
      label: "Reorder at",
      align: "right",
      secondary: true,
      render: (r) => {
        if (r.reorderPoint <= 0) return <span className="text-gray-400">—</span>;
        const low = r.itemFree <= r.reorderPoint;
        return (
          <>
            <span className="tnum text-gray-600">{r.reorderPoint}</span>
            {low && (
              <p className="mt-0.5 text-xs font-medium text-danger-700">
                <span className="tnum">{r.itemFree}</span> free in all
              </p>
            )}
          </>
        );
      },
    },
    {
      key: "storage",
      label: "Storage location",
      sortable: true,
      secondary: true,
      render: (r) => r.storageLocation ?? <span className="text-gray-400">—</span>,
    },
  ];

  const receiveItems = manager
    ? (
        await db
          .select({ id: items.id, label: items.name, unit: items.unitOfMeasure })
          .from(items)
          .where(eq(items.active, true))
          .orderBy(asc(items.name))
      ).map((i) => ({ id: i.id, label: i.label, unit: i.unit }))
    : [];
  const receiveLocations = manager
    ? (
        await db
          .select({ id: inventoryLocations.id, label: inventoryLocations.name })
          .from(inventoryLocations)
          .orderBy(asc(inventoryLocations.name))
      ).map((l) => ({ id: l.id, label: l.label }))
    : [];
  const vendorOptions = manager
    ? (
        await db
          .select({ id: vendors.id, label: vendors.name })
          .from(vendors)
          .where(eq(vendors.active, true))
          .orderBy(asc(vendors.name))
      ).map((v) => ({ id: v.id, label: v.label }))
    : [];

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Stores"
        title="Inventory"
        subtitle="Materials and bought-in parts, batch by batch."
      />

      <Link
        href="/materials"
        className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-gray-800 underline"
      >
        What the open jobs still need →
      </Link>

      <div className="mt-7 grid gap-4 sm:grid-cols-4">
        <Stat label="On the racks" value={unitsOnHand} note={`${itemsTracked.size} materials`} />
        <Stat label="Free to use" value={unitsFree} />
        <Stat label="Promised to jobs" value={unitsPromised} />
        <Stat
          label="Need buying"
          value={belowReorder.length}
          tone={belowReorder.length ? "alert" : "default"}
          note="Free stock at or under the reorder point"
        />
      </div>

      {manager && (
        <section className="mt-8 space-y-4">
          <ReceiveForm
            items={receiveItems}
            locations={receiveLocations}
            vendors={vendorOptions}
          />
        </section>
      )}

      {/* Open to everyone: the handler who lifts the pallet is the one who finds
          it damaged, and sending them to find a supervisor is how damage stops
          being recorded at all. */}
      <section className="mt-8">
        <ScanAndReject />
      </section>

      {untraceable > 0 && (
        <Panel className="mt-8 border-l-2 border-l-warning-500 px-5 py-4">
          <p className="text-sm text-gray-600">
            <span className="tnum font-medium text-gray-900">{untraceable}</span> units carry no
            batch label and cannot be traced to a heat.
          </p>
        </Panel>
      )}

      <section className="mt-8">
        <SectionHeading
          note={`${itemsTracked.size} ${itemsTracked.size === 1 ? "item" : "items"} · ${lotCount} ${lotCount === 1 ? "batch" : "batches"}`}
        >
          Stock by batch
        </SectionHeading>

        <DataTable
          basePath="/inventory"
          query={query}
          page={page}
          columns={stockColumns}
          rowKey={(r) => r.key}
          caption="Stock by batch"
          searchPlaceholder="Item, SKU, location, batch or heat number"
          filters={[
            { key: "all", label: "All", count: stockRows.length },
            { key: "free", label: "Free stock", count: counts.free },
            { key: "committed", label: "Nothing free", count: counts.committed },
            { key: "held", label: "Quarantined", count: counts.held },
            { key: "untraced", label: "No label", count: counts.untraced },
          ]}
          empty={{
            title: "No stock records yet",
            hint: "Booking a delivery in creates the first batch, with its label.",
          }}
        />
      </section>
    </div>
  );
}
