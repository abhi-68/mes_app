import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { items, stations, users, reasonCodes, workOrders } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { Panel, PageHeader } from "@/components/ui";

const SECTIONS = [
  {
    href: "/admin/products",
    title: "Products & processes",
    body: "Define what you make, the steps to make it, and what each one is built from. This is where a different process per product gets set up.",
  },
  {
    href: "/orders/new",
    title: "Raise a work order",
    body: "Start a new unit. The step list and every sub-assembly order are created automatically from the product's routing and parts list.",
  },
  {
    href: "/admin/people",
    title: "People & stations",
    body: "Add workers, supervisors and admins, set which station each person works at, and manage the station list itself.",
  },
  {
    href: "/admin/reason-codes",
    title: "Reason codes",
    body: "The fixed lists people pick from when something is blocked, scrapped or reworked. Fixed lists are what make these countable later.",
  },
];

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "ADMIN") redirect("/");

  const [itemRows, stationRows, userRows, reasonRows, orderRows] = await Promise.all([
    db.select({ id: items.id }).from(items),
    db.select({ id: stations.id }).from(stations),
    db.select({ id: users.id }).from(users),
    db.select({ id: reasonCodes.id }).from(reasonCodes),
    db.select({ id: workOrders.id }).from(workOrders),
  ]);

  const counts: Record<string, number> = {
    "/admin/products": itemRows.length,
    "/orders/new": orderRows.length,
    "/admin/people": userRows.length + stationRows.length,
    "/admin/reason-codes": reasonRows.length,
  };

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title="Setup"
        subtitle="Products, people, stations and reason codes."
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Panel key={s.href} className="transition-colors hover:ring-gray-300">
            <Link href={s.href} className="block px-5 py-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-medium text-gray-950">{s.title}</h2>
                <span className="text-sm tabular-nums text-gray-400">{counts[s.href]}</span>
              </div>
              <p className="mt-2 text-sm text-gray-500">{s.body}</p>
            </Link>
          </Panel>
        ))}
      </div>
    </div>
  );
}
