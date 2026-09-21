import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { items, customers, workOrders, stations, routingSteps, bomLines } from "@/db/schema";
import { getCurrentUser, isManager } from "@/lib/session";
import { Panel, PageHeader, SectionHeading, StatusPill, formatRelativeDue } from "@/components/ui";
import { NewOrderForm } from "@/components/NewOrderForm";

export default async function NewWorkOrderPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  // Supervisors raise orders too — this is daily work, not setup, which is why
  // it does not live under /admin where the proxy admits admins only.
  if (!isManager(user.role)) redirect("/");

  const [products, customerRows, recent, partRows, stationRows, workTypeRows, allBom, allSteps] =
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
    db
      .select({
        itemId: bomLines.parentItemId,
        componentItemId: bomLines.componentItemId,
        quantity: bomLines.quantity,
        stepId: bomLines.consumedAtRoutingStepId,
      })
      .from(bomLines),
    db
      .select({
        id: routingSteps.id,
        itemId: routingSteps.itemId,
        name: routingSteps.name,
        stationId: routingSteps.stationId,
        sequence: routingSteps.sequence,
      })
      .from(routingSteps)
      .orderBy(asc(routingSteps.itemId), asc(routingSteps.sequence)),
  ]);

  /**
   * Every product that can be repeated, with its specification attached.
   *
   * Assembled here rather than fetched on demand because the list is small and a
   * dropdown that has to wait for a round trip before it can fill the form is a
   * dropdown people stop using.
   */
  const productSpecs = products.map((p) => {
    const steps = allSteps.filter((st) => st.itemId === p.id);
    const stepIndex = new Map(steps.map((st, i) => [st.id, i]));
    return {
      id: p.id,
      label: `${p.name} (${p.sku})`,
      steps: steps.map((st) => ({ name: st.name, stationId: st.stationId })),
      materials: allBom
        .filter((b) => b.itemId === p.id)
        .map((b) => ({
          itemId: b.componentItemId,
          quantity: b.quantity,
          stepIndex: b.stepId !== null ? stepIndex.get(b.stepId) ?? 0 : 0,
        })),
    };
  });

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title="Raise a work order"
        subtitle="Pick a product and quantity. Every step and every sub-assembly order is created for you from that product's setup."
        actions={
          <Link
            href="/orders"
            className="inline-flex min-h-11 items-center text-sm text-steel-500 hover:text-navy-900"
          >
            Back to setup
          </Link>
        }
      />

      {/* One form, not two. Made to order is the common case here — the product
          does not exist yet — and repeating a previous one is the dropdown at the
          top of this same form, so a second "repeat order" form beside it only
          gave two buttons that did the same job. */}
      <section className="mt-6">
        <NewOrderForm
          customers={customerRows.map((c) => ({ id: c.id, label: c.name }))}
          parts={partRows.map((p) => ({ id: p.id, label: `${p.name} (${p.sku})` }))}
          stations={stationRows.map((s) => ({ id: s.id, label: s.name }))}
          workTypes={workTypeRows.map((w) => w.name)}
          products={productSpecs}
        />
      </section>

      {/* Nothing raised yet means an empty bordered box, which reads as a fault
          rather than a fresh start. */}
      {recent.length > 0 && (
      <section className="mt-10">
        <SectionHeading>Recently raised</SectionHeading>
        <Panel className="divide-y divide-steel-100">
          {recent.map((o) => (
            <Link
              key={o.id}
              href={`/orders/${o.id}`}
              className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-steel-50"
            >
              <div>
                <p className="text-sm font-medium text-steel-900 tnum">{o.orderNumber}</p>
                <p className="text-xs text-steel-400">
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
