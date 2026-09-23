import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { items, routingSteps, bomLines } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { Panel, PageHeader, SectionHeading } from "@/components/ui";
import { NewItemForm } from "@/components/admin-forms";

export default async function ProductsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "ADMIN") redirect("/");

  const all = await db.select().from(items).orderBy(asc(items.sku));
  const steps = await db.select({ itemId: routingSteps.itemId }).from(routingSteps);
  const boms = await db.select({ parentItemId: bomLines.parentItemId }).from(bomLines);

  const stepCount = (id: number) => steps.filter((s) => s.itemId === id).length;
  const bomCount = (id: number) => boms.filter((b) => b.parentItemId === id).length;

  const made = all.filter((i) => i.procurementType === "MANUFACTURED");
  const bought = all.filter((i) => i.procurementType === "PURCHASED");

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title="Products & processes"
        subtitle="What you make, and what you buy in."
        actions={
          <Link
            href="/admin"
            className="inline-flex min-h-11 items-center text-sm text-gray-500 hover:text-gray-950"
          >
            Back to setup
          </Link>
        }
      />

      <section className="mt-8">
        <SectionHeading note={`${made.length} made here`}>Made here</SectionHeading>
        <Panel className="divide-y divide-gray-100">
          {made.map((item) => (
            <Link
              key={item.id}
              href={`/admin/products/${item.id}`}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-gray-50"
            >
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {item.name}
                  {item.isFinishedGood && (
                    <span className="ml-2 rounded bg-primary-100 px-1.5 py-0.5 text-xs text-gray-800">
                      sold product
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-400 tnum">{item.sku}</p>
              </div>
              <p className="text-xs text-gray-400">
                {stepCount(item.id)} steps · {bomCount(item.id)} components
              </p>
            </Link>
          ))}
        </Panel>
      </section>

      <section className="mt-8">
        <SectionHeading note={`${bought.length} bought in`}>Bought in</SectionHeading>
        <Panel className="divide-y divide-gray-100">
          {bought.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div>
                <p className="text-sm text-gray-900">{item.name}</p>
                <p className="text-xs text-gray-400 tnum">{item.sku}</p>
              </div>
              <p className="text-xs text-gray-400">per {item.unitOfMeasure}</p>
            </div>
          ))}
        </Panel>
      </section>

      <section className="mt-8">
        <SectionHeading>Add a product</SectionHeading>
        <Panel className="p-5">
          <NewItemForm />
        </Panel>
      </section>
    </div>
  );
}
