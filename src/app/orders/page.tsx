import Link from "next/link";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { deliveryNotes, users, workOrders } from "@/db/schema";
import { getProgressTree, type ProgressNode } from "@/lib/work-orders";
import { getCurrentUser, isManager } from "@/lib/session";
import { readTableQuery, sortRows, paginate } from "@/lib/table";
import { DataTable, type Column } from "@/components/DataTable";
import { Dispatch, type DispatchRow } from "@/components/Dispatch";
import { PageHeader, ProgressBar, StatusPill, formatRelativeDue } from "@/components/ui";

export const dynamic = "force-dynamic";

const SORTABLE = ["orderNumber", "item", "customer", "quantity", "status", "progress", "due"];

type Row = {
  id: number;
  orderNumber: string;
  itemName: string;
  customerName: string | null;
  quantity: number;
  status: string;
  dueDate: Date | null;
  progress: number;
  blockedCount: number;
  children: ProgressNode["children"];
};

export default async function OrdersPage(props: PageProps<"/orders">) {
  const sp = await props.searchParams;
  const query = readTableQuery(sp, { sortable: SORTABLE });
  const user = await getCurrentUser();

  const topLevel = await db.query.workOrders.findMany({
    where: isNull(workOrders.parentWorkOrderId),
    orderBy: [desc(workOrders.createdAt)],
    with: { item: true, customer: true },
  });
  const trees = await Promise.all(topLevel.map((o) => getProgressTree(o.id)));

  const all: Row[] = topLevel.map((order, i) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    itemName: order.item.name,
    customerName: order.customer?.name ?? null,
    quantity: order.quantity,
    status: order.status,
    dueDate: order.dueDate,
    progress: trees[i]?.progress ?? 0,
    blockedCount: trees[i]?.blockedCount ?? 0,
    children: trees[i]?.children ?? [],
  }));

  const counts = {
    all: all.length,
    open: all.filter(
      (r) => !["DONE", "IN_TRANSIT", "SHIPPED", "CANCELLED"].includes(r.status)
    ).length,
    blocked: all.filter((r) => r.blockedCount > 0).length,
    done: all.filter((r) => r.status === "DONE").length,
    shipped: all.filter((r) => r.status === "SHIPPED").length,
  };

  // Dispatch used to be a screen of its own. It is a property of an order, so it
  // lives with the orders.
  const dispatchRows: DispatchRow[] = await Promise.all(
    all
      .filter((r) => r.status === "DONE" || r.status === "IN_TRANSIT")
      .map(async (r) => {
        const [note] = await db
          .select({
            noteNumber: deliveryNotes.noteNumber,
            handlerName: users.name,
          })
          .from(deliveryNotes)
          .leftJoin(users, eq(deliveryNotes.handlerUserId, users.id))
          .where(
            and(eq(deliveryNotes.workOrderId, r.id), ne(deliveryNotes.status, "CANCELLED"))
          )
          .limit(1);
        return {
          id: r.id,
          orderNumber: r.orderNumber,
          itemName: r.itemName,
          customerName: r.customerName,
          quantity: r.quantity,
          status: r.status,
          noteNumber: note?.noteNumber ?? null,
          handlerName: note?.handlerName ?? null,
        };
      })
  );

  const needle = query.q.toLowerCase();
  const filtered = all.filter((r) => {
    if (needle) {
      const haystack = `${r.orderNumber} ${r.itemName} ${r.customerName ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (query.filter === "open")
      return !["DONE", "IN_TRANSIT", "SHIPPED", "CANCELLED"].includes(r.status);
    if (query.filter === "blocked") return r.blockedCount > 0;
    if (query.filter === "done") return r.status === "DONE";
    if (query.filter === "shipped") return r.status === "SHIPPED";
    return true;
  });

  const sorted = sortRows(filtered, query.sort, query.dir, (r, c) =>
    c === "orderNumber"
      ? r.orderNumber
      : c === "item"
        ? r.itemName
        : c === "customer"
          ? r.customerName
          : c === "quantity"
            ? r.quantity
            : c === "status"
              ? r.status
              : c === "progress"
                ? r.progress
                : c === "due"
                  ? r.dueDate
                  : null
  );
  const page = paginate(sorted, query.page, query.perPage);

  const columns: Column<Row>[] = [
    {
      key: "orderNumber",
      label: "Order number",
      sortable: true,
      render: (r) => (
        <Link
          href={`/orders/${r.id}`}
          className="tnum inline-flex min-h-11 items-center font-medium text-gray-800 hover:underline"
        >
          {r.orderNumber}
        </Link>
      ),
    },
    {
      key: "item",
      label: "Item",
      sortable: true,
      render: (r) => (
        <>
          <p className="text-gray-800">{r.itemName}</p>
          {r.children.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-400">
              {r.children.length} sub-assembl{r.children.length === 1 ? "y" : "ies"}
              {r.blockedCount > 0 && (
                <span className="text-danger-700"> · {r.blockedCount} blocked</span>
              )}
            </p>
          )}
        </>
      ),
    },
    {
      key: "customer",
      label: "Customer",
      sortable: true,
      secondary: true,
      render: (r) => r.customerName ?? <span className="text-gray-400">—</span>,
    },
    {
      key: "quantity",
      label: "Qty",
      sortable: true,
      align: "right",
      render: (r) => <span className="tnum">{r.quantity}</span>,
    },
    {
      key: "progress",
      label: "Progress",
      sortable: true,
      secondary: true,
      render: (r) => (
        <div className="flex items-center gap-2">
          <div className="w-24">
            <ProgressBar value={r.progress} tone={r.blockedCount > 0 ? "blocked" : "auto"} />
          </div>
          <span className="tnum w-9 text-right text-xs text-gray-500">
            {Math.round(r.progress * 100)}%
          </span>
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (r) => <StatusPill status={r.status} size="sm" />,
    },
    {
      key: "due",
      label: "Due",
      sortable: true,
      secondary: true,
      align: "right",
      render: (r) => (
        <span className="whitespace-nowrap text-gray-500">{formatRelativeDue(r.dueDate)}</span>
      ),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-9">
      <PageHeader
        title="Work orders"
        subtitle="Sub-assemblies live inside their parent unit."
      />

      <Dispatch rows={dispatchRows} canShip={user ? isManager(user.role) : false} />

      <div className="mt-6">
        <DataTable
          basePath="/orders"
          query={query}
          page={page}
          columns={columns}
          rowKey={(r) => r.id}
          caption="Work orders"
          searchPlaceholder="Order number, item or customer"
          filters={[
            { key: "all", label: "All", count: counts.all },
            { key: "open", label: "In build", count: counts.open },
            { key: "blocked", label: "Blocked", count: counts.blocked },
            { key: "done", label: "Built", count: counts.done },
            { key: "shipped", label: "Shipped", count: counts.shipped },
          ]}
          action={
            user && isManager(user.role)
              ? { href: "/orders/new", label: "New order" }
              : undefined
          }
          empty={{
            title: "No work orders",
            hint: "Raise one against a product that has a routing.",
          }}
        />
      </div>
    </div>
  );
}
