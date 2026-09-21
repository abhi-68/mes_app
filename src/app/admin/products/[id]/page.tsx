import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { items, routingSteps, bomLines, stations } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { PageHeader, SectionHeading } from "@/components/ui";
import { RoutingEditor, BomEditor } from "@/components/admin-forms";

export default async function ProductSetupPage(props: PageProps<"/admin/products/[id]">) {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "ADMIN") redirect("/");

  const { id } = await props.params;
  const itemId = Number(id);
  if (Number.isNaN(itemId)) notFound();

  const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
  if (!item) notFound();

  const steps = await db.query.routingSteps.findMany({
    where: eq(routingSteps.itemId, itemId),
    with: { station: true },
    orderBy: [asc(routingSteps.sequence)],
  });

  const lines = await db.query.bomLines.findMany({
    where: eq(bomLines.parentItemId, itemId),
    with: { componentItem: true, consumedAtStep: true },
  });

  const [stationRows, allItems] = await Promise.all([
    db.select({ id: stations.id, name: stations.name }).from(stations).where(eq(stations.active, true)),
    db.select({ id: items.id, name: items.name, sku: items.sku }).from(items).orderBy(asc(items.sku)),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title={item.name}
        subtitle={`${item.sku} · ${item.procurementType === "MANUFACTURED" ? "made here" : "bought in"}`}
        actions={
          <Link href="/admin/products" className="text-sm text-steel-500 hover:text-navy-900">
            All products
          </Link>
        }
      />

      <section className="mt-8">
        <SectionHeading note="Runs in this order">Process steps</SectionHeading>
        <RoutingEditor
          itemId={itemId}
          steps={steps.map((s) => ({
            id: s.id,
            sequence: s.sequence,
            name: s.name,
            stationName: s.station?.name ?? null,
            expectedMinutes: s.expectedMinutes,
          }))}
          stations={stationRows}
        />
      </section>

      <section className="mt-10">
        <SectionHeading note="Each line says when stock is taken">Built from</SectionHeading>
        <BomEditor
          parentItemId={itemId}
          lines={lines.map((l) => ({
            id: l.id,
            componentName: l.componentItem.name,
            componentSku: l.componentItem.sku,
            quantity: l.quantity,
            consumedAtStepName: l.consumedAtStep?.name ?? null,
          }))}
          allItems={allItems.filter((i) => i.id !== itemId)}
          steps={steps.map((s) => ({ id: s.id, name: s.name }))}
        />
      </section>
    </div>
  );
}
