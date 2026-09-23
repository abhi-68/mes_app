import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { items, customers, workOrders, stations, routingSteps } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { Panel, PageHeader, SectionHeading, StatusPill, formatRelativeDue } from "@/components/ui";
import { NewOrderForm } from "@/components/NewOrderForm";
import { RepeatOrderForm } from "@/components/RepeatOrderForm";

export default async function NewWorkOrderPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  // Supervisors raise orders too — this is daily work, not setup, which is why
  // it does not live under /admin where the proxy admits admins only.
  if (!isManager(user.role)) redirect("/");

  const [products, customerRows, recent, partRows, stationRows, workTypeRows] =
    await Promise.all([
    db
      .select({ id: items.id, name: items.name, sku: items.sku })
      .from(items)
      .where(eq(items.procurementType, "MANUFACTURED"))
      .orderBy(asc(items.sku)),
    db.select({ id: customers.id, name: customers.name }).from(customers).orderBy(asc(customers.name)),
    db.query.workOrders.findMany({
      where: isNull(workOrders.parentWorkOrderId),
      orderBy: [desc(workOrders.createdAt)],
      with: { item: true },
      limit: 8,
    }),
    db
      .select({ id: items.id, name: items.name, sku: items.sku })
      .from(items)
      .where(eq(items.active, true))
      .orderBy(asc(items.name)),
    db
      .select({ id: stations.id, name: stations.name })
      .from(stations)
      .where(eq(stations.active, true))
      .orderBy(asc(stations.sortOrder), asc(stations.id)),
    // The kinds of work this shop actually does, taken from the routings it has
    // rather than a list somebody has to maintain.
    db
      .selectDistinct({ name: routingSteps.name })
      .from(routingSteps)
      .orderBy(asc(routingSteps.name)),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title="Raise a work order"
        subtitle="Steps and sub-assembly orders are created from the product."
        actions={
          <Link
            href="/orders"
            className="inline-flex min-h-11 items-center text-sm text-gray-500 hover:text-gray-950"
          >
            Back to setup
          </Link>
        }
      />

      {/* Two forms because they do two different things. This one reuses a
          product; the one below defines a new one. Raising a repeat through the
          made-to-order form clones the product instead, and a catalogue of
          near-identical part numbers is how reports stop adding up. */}
      <section className="mt-6 space-y-6">
        <RepeatOrderForm
          products={products.map((p) => ({ id: p.id, label: `${p.name} (${p.sku})` }))}
          customers={customerRows.map((c) => ({ id: c.id, label: c.name }))}
        />

        <NewOrderForm
          customers={customerRows.map((c) => ({ id: c.id, label: c.name }))}
          parts={partRows.map((p) => ({ id: p.id, label: `${p.name} (${p.sku})` }))}
          stations={stationRows.map((s) => ({ id: s.id, label: s.name }))}
          workTypes={workTypeRows.map((w) => w.name)}
        />
      </section>

      {/* Nothing raised yet means an empty bordered box, which reads as a fault
          rather than a fresh start. */}
      {recent.length > 0 && (
      <section className="mt-10">
        <SectionHeading>Recently raised</SectionHeading>
        <Panel className="divide-y divide-gray-100">
          {recent.map((o) => (
            <Link
              key={o.id}
              href={`/orders/${o.id}`}
              className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-gray-50"
            >
              <div>
                <p className="text-sm font-medium text-gray-900 tnum">{o.orderNumber}</p>
                <p className="text-xs text-gray-400">
                  {o.item.name} · Qty {o.quantity} · {formatRelativeDue(o.dueDate)}
                </p>
              </div>
              <StatusPill status={o.status} size="sm" />
            </Link>
          ))}
        </Panel>
      </section>
      )}
    </div>
  );
}
