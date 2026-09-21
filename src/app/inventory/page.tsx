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

  const balances = await db.query.inventoryBalances.findMany({
    with: { item: true, location: true },
    orderBy: [asc(inventoryBalances.id)],
  });

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

  const committed = withLots.filter((r) => r.available <= 0 && r.onHand > 0);
  const onHold = withLots.filter((r) => r.held > 0);
  const belowReorder = withLots.filter((r) => r.reorderPoint > 0 && r.available <= r.reorderPoint);
  const lotCount = withLots.reduce((s, r) => s + r.lots.length, 0);
  const untraceable = withLots.reduce((s, r) => s + Math.max(0, r.unlotted), 0);

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
          <p className="text-steel-800">{r.itemName}</p>
          <p className="tnum mt-0.5 font-mono text-xs text-steel-400">{r.sku}</p>
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
          <span className="text-steel-400">—</span>
        ),
    },
    {
      key: "batch",
      label: "Batch number",
      sortable: true,
      render: (r) =>
        r.batchNumber ? (
          <div className="flex items-center gap-2">
            <span className="tnum font-mono text-xs">{r.batchNumber}</span>
            <BarcodeLabel code={r.batchNumber} compact />
          </div>
        ) : (
          <Chip tone="quiet">No batch</Chip>
        ),
    },
    { key: "uom", label: "UOM", render: (r) => <span className="text-steel-500">{r.unit}</span> },
    {
      key: "available",
      label: "Available",
      sortable: true,
      align: "right",
      render: (r) => {
        const free = r.onHand - r.reserved - r.held;
        return (
          <>
            <span className="tnum font-medium text-steel-900">{r.available}</span>
            {(r.reserved > 0 || r.held > 0) && (
              <p className="tnum mt-0.5 text-xs text-steel-400">
                {r.reserved > 0 ? `${r.reserved} committed` : ""}
                {r.reserved > 0 && r.held > 0 ? " · " : ""}
                {r.held > 0 ? `${r.held} held` : ""}
              </p>
            )}
            {free <= 0 && r.onHand > 0 && (
              <p className="mt-0.5 text-xs text-blocked-fg">none free</p>
            )}
          </>
        );
      },
    },
    {
      key: "reorder",
      label: "Reorder at",
      align: "right",
      secondary: true,
      render: (r) => {
        if (r.reorderPoint <= 0) return <span className="text-steel-400">—</span>;
        const free = r.onHand - r.reserved - r.held;
        const low = free <= r.reorderPoint;
        return (
          <>
            <span className="tnum text-steel-600">{r.reorderPoint}</span>
            {low && <p className="mt-0.5 text-xs font-medium text-blocked-fg">below</p>}
          </>
        );
      },
    },
    {
      key: "storage",
      label: "Storage location",
      sortable: true,
      secondary: true,
      render: (r) => r.storageLocation ?? <span className="text-steel-400">—</span>,
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
        title="Stock"
        subtitle="What is on the racks, batch by batch. Finished units land here too when their last step is signed off."
      />

      <Link
        href="/materials"
        className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-navy-800 underline"
      >
        What the open jobs still need →
      </Link>

      <div className="mt-7 grid gap-4 sm:grid-cols-4">
        <Stat label="Items tracked" value={withLots.length} />
        <Stat label="Batches on hand" value={lotCount} note="Each with its own label" />
        <Stat
          label="Fully committed"
          value={committed.length}
          tone={committed.length ? "alert" : "default"}
          note="On hand, but none of it free"
        />
        <Stat
          label="Below reorder point"
          value={belowReorder.length}
          tone={belowReorder.length ? "alert" : "default"}
          note={
            belowReorder.length
              ? "Supervisors are alerted"
              : onHold.length
                ? `${onHold.length} on quality hold`
                : "Nothing to buy"
          }
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
        <Panel className="mt-8 border-l-2 border-l-active-solid px-5 py-4">
          <p className="text-sm text-steel-600">
            <span className="tnum font-medium text-steel-900">{untraceable}</span> units on hand
            have no batch behind them — stock that was entered as an opening balance rather than
            received against a delivery. They are usable, and they cannot be traced to a heat.
            Anything received from now on can be.
          </p>
        </Panel>
      )}

      <section className="mt-8">
        <SectionHeading note={`${withLots.length} items · ${lotCount} batches`}>
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
            { key: "committed", label: "Fully committed", count: counts.committed },
            { key: "held", label: "On hold", count: counts.held },
            { key: "untraced", label: "No batch", count: counts.untraced },
          ]}
          empty={{
            title: "No stock records yet",
            hint: "Booking a delivery in creates the first batch, with its label.",
          }}
        />
      </section>

      <Panel className="mt-8 px-5 py-4">
        <p className="text-sm text-steel-500">
          A batch&apos;s remaining quantity is not stored anywhere — it is the sum of every
          movement that touched it. That is why these numbers cannot drift from the balance
          above them: there is only one number, counted two ways.
        </p>
      </Panel>
    </div>
  );
}
