import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser, isManager } from "@/lib/session";
import { deliveryNoteList, deliverySummary, shippableOrders } from "@/lib/delivery";
import { DeliveryNoteTable, RaiseDeliveryNoteForm } from "@/components/DeliveryNotes";
import { PageHeader, SectionHeading, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "UNASSIGNED", label: "Unassigned" },
  { key: "ALLOCATED", label: "Allocated" },
  { key: "PICKED_UP", label: "Picked up" },
  { key: "DELIVERED", label: "Delivered" },
  { key: "CANCELLED", label: "Cancelled" },
] as const;

export default async function DeliveryNotesPage(props: PageProps<"/delivery-notes">) {
  const sp = await props.searchParams;
  const status = (Array.isArray(sp.status) ? sp.status[0] : sp.status) ?? "all";
  const user = await requireUser();
  const canDispatch = isManager(user.role);

  const [notes, shippable, summary, handlers] = await Promise.all([
    deliveryNoteList(status),
    shippableOrders(),
    deliverySummary(),
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(asc(users.name)),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Dispatch"
        title="Delivery notes"
        subtitle="The record that finished goods left the building. A note is raised against an order, given to whoever is carrying it, and closed when it arrives."
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open notes" value={summary.open} note="Raised and not yet delivered" />
        <Stat
          label="Nobody assigned"
          value={summary.unassigned}
          tone={summary.unassigned > 0 ? "alert" : "default"}
          note="Needs a handler"
        />
        <Stat label="In transit" value={summary.inTransit} note="Picked up, not arrived" />
        <Stat label="Delivered today" value={summary.deliveredToday} note="Arrived" />
      </div>

      {canDispatch && (
        <section className="mt-9">
          <SectionHeading note="Quantity is capped at what the order has not already promised">
            Raise a note
          </SectionHeading>
          <RaiseDeliveryNoteForm shippable={shippable} handlers={handlers} />
        </section>
      )}

      <section className="mt-10">
        <SectionHeading note="Newest first">Notes</SectionHeading>

        <div className="mb-4 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/delivery-notes" : `/delivery-notes?status=${f.key}`}
              className={`inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium transition-colors ${
                status === f.key
                  ? "bg-navy-800 text-white"
                  : "border border-steel-300 bg-white text-steel-600 hover:bg-steel-50"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        <DeliveryNoteTable notes={notes} handlers={handlers} canDispatch={canDispatch} />
      </section>
    </div>
  );
}
