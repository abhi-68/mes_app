import Link from "next/link";
import type { AdminHome } from "@/lib/home";
import type { SessionUser } from "@/lib/session";
import {
  PageHeader,
  Panel,
  SectionHeading,
  EmptyState,
  Stat,
  Chip,
  LinkButton,
  formatRelativeDue,
} from "@/components/ui";

/**
 * An admin's home screen answers: what is not set up yet, and what is waiting
 * on me to release it?
 *
 * The setup-gap list is the part worth having. Every entry is a configuration
 * mistake that does not fail at the moment it is made — it fails weeks later,
 * on the floor, as a step nobody can start or a shortage nobody was warned
 * about. Each one says what will go wrong rather than naming the missing field,
 * because "3 products have no routing" means nothing to the person who has to
 * fix it and "a work order for these would release with nothing for anyone to
 * do" means everything.
 */
export function AdminHomeScreen({
  data,
  user,
  alertCount,
}: {
  data: AdminHome;
  user: SessionUser;
  alertCount: number;
}) {
  const firstName = user.name.split(" ")[0];
  const clean = data.gaps.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-9">
      <PageHeader
        eyebrow="Setup"
        title={`Hello, ${firstName}`}
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-4">
        <Stat
          label="Awaiting release"
          value={data.awaitingRelease.length}
          tone={data.awaitingRelease.length ? "alert" : "default"}
          note="Planned, not yet on the floor"
        />
        <Stat
          label="Setup gaps"
          value={data.gaps.length}
          tone={data.gaps.length ? "alert" : "default"}
          note={data.gaps.length ? "Will bite later" : "Nothing missing"}
        />
        <Stat
          label="Stock exceptions"
          value={data.stockExceptions.length}
          tone="muted"
          note="Low, held or negative"
        />
        {/* A ratio of people to products meant nothing; the number an admin is
            actually asked for is how much is open. The configured counts stay as
            the note, where they read as context rather than as a figure. */}
        <Stat
          label="Orders open"
          value={data.counts.openOrders}
          tone="muted"
          note={`${data.counts.people} people · ${data.counts.products} products · ${data.counts.stations} stations`}
        />
      </div>

      {/* --- awaiting release ---------------------------------------------- */}
      <section className="mt-8">
        <SectionHeading>
          Waiting for you to release
        </SectionHeading>
        {data.awaitingRelease.length === 0 ? (
          <EmptyState
            title="Nothing planned is waiting"

          />
        ) : (
          <Panel className="divide-y divide-gray-100 overflow-hidden border-l-2 border-l-warning-500">
            {data.awaitingRelease.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="tnum text-sm font-medium text-gray-950">
                      {o.orderNumber}
                    </span>
                    <span className="text-[0.9375rem] text-gray-700">{o.itemName}</span>
                    <Chip tone="quiet">×{o.quantity}</Chip>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {o.customerName ?? "No customer"} · {formatRelativeDue(o.dueDate)}
                  </p>
                </div>
                <LinkButton href={`/orders/${o.id}`} tone="primary">
                  Review and release
                </LinkButton>
              </div>
            ))}
          </Panel>
        )}
      </section>

      {/* --- setup gaps ------------------------------------------------------ */}
      <section className="mt-8">
        <SectionHeading>
          Missing setup
        </SectionHeading>
        {clean ? (
          <EmptyState
            title="Nothing missing"

          />
        ) : (
          <Panel className="divide-y divide-gray-100 overflow-hidden">
            {data.gaps.map((g) => (
              <div
                key={g.key}
                className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[0.9375rem] font-medium text-gray-900">{g.title}</p>
                  <p className="mt-1 text-sm text-gray-500">{g.detail}</p>
                </div>
                <LinkButton href={g.href}>
                  Fix it
                </LinkButton>
              </div>
            ))}
          </Panel>
        )}
      </section>

      {/* --- stock exceptions ------------------------------------------------ */}
      {data.stockExceptions.length > 0 && (
        <section className="mt-8">
          <SectionHeading>
            Stock worth looking at
          </SectionHeading>
          <Panel className="divide-y divide-gray-100 overflow-hidden">
            {data.stockExceptions.map((s) => (
              <div
                key={s.itemId}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm text-gray-900">{s.name}</p>
                  <p className="tnum mt-0.5 text-xs text-gray-400">{s.sku}</p>
                </div>
                <div className="flex shrink-0 items-baseline gap-4 text-sm">
                  {s.held > 0 && <Chip tone="alert">{s.held} on hold</Chip>}
                  <span
                    className={`tnum font-medium ${
                      s.free < 0 ? "text-danger-700" : "text-gray-900"
                    }`}
                  >
                    {s.free} {s.uom} free
                  </span>
                  {s.reorderPoint > 0 && (
                    <span className="tnum text-xs text-gray-400">
                      reorder at {s.reorderPoint}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </Panel>
        </section>
      )}

      <div className="mt-9 flex flex-wrap gap-2">
        <Link
          href="/admin"
          className="inline-flex min-h-9 items-center rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          Setup
        </Link>
        <Link
          href="/alerts"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          Alerts
          {alertCount > 0 && (
            <span className="tnum rounded bg-danger-50 px-1.5 text-xs font-medium text-danger-700">
              {alertCount}
            </span>
          )}
        </Link>
      </div>
    </div>
  );
}
