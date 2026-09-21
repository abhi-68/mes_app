import Link from "next/link";
import type { ReactNode } from "react";
import {
  PER_PAGE_CHOICES,
  nextSortFor,
  tableHref,
  type Page,
  type TableQuery,
} from "@/lib/table";
import { Panel, EmptyState, TH, TD, TR } from "@/components/ui";

/**
 * One list screen, shared by every list screen.
 *
 * Search, tab filters, sortable headings, per-page and paging — all plain links
 * and a GET form, so there is no client component and every view is a real URL.
 * The point is that the orders list, the stock list and the dispatch list behave
 * identically: whatever you learn on one, you already know on the others.
 */

export type Column<T> = {
  key: string;
  label: string;
  /** Sortable columns must be on the page's allow-list too, or the URL is ignored. */
  sortable?: boolean;
  align?: "left" | "right";
  /** Hide on narrow screens, for the columns a phone does not need. */
  secondary?: boolean;
  render: (row: T) => ReactNode;
};

export type FilterTab = { key: string; label: string; count?: number };

export function DataTable<T>({
  basePath,
  query,
  page,
  columns,
  rowKey,
  filters,
  searchPlaceholder,
  action,
  empty,
  caption,
}: {
  basePath: string;
  query: TableQuery;
  page: Page<T>;
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  filters?: FilterTab[];
  searchPlaceholder?: string;
  /** The primary "New …" button, when the screen has one. */
  action?: { href: string; label: string };
  empty?: { title: string; hint?: string };
  caption?: string;
}) {
  const href = (changes: Partial<TableQuery>) => tableHref(basePath, query, changes);

  return (
    <div>
      {/* Filters + search + new */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {filters && filters.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {filters.map((f) => {
              const active = query.filter === f.key;
              return (
                <Link
                  key={f.key}
                  href={href({ filter: f.key })}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors ${
                    active
                      ? "bg-navy-800 text-white"
                      : "border border-steel-300 bg-white text-steel-600 hover:bg-steel-50"
                  }`}
                >
                  {f.label}
                  {f.count !== undefined && (
                    <span className={`tnum text-xs ${active ? "text-white/70" : "text-steel-400"}`}>
                      {f.count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ) : (
          <span />
        )}

        {action && (
          <Link
            href={action.href}
            className="inline-flex min-h-11 items-center rounded-md bg-navy-800 px-4 text-sm font-medium text-white transition-colors hover:bg-navy-900"
          >
            {action.label}
          </Link>
        )}
      </div>

      <form method="get" action={basePath} role="search" className="mt-3 flex flex-wrap gap-2">
        {/* Searching keeps the filter, the sort and the page size; it resets the page. */}
        {query.filter !== "all" && <input type="hidden" name="filter" value={query.filter} />}
        {query.sort && <input type="hidden" name="sort" value={query.sort} />}
        {query.sort && query.dir !== "asc" && <input type="hidden" name="dir" value={query.dir} />}
        {query.perPage !== 10 && <input type="hidden" name="perPage" value={query.perPage} />}
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder={searchPlaceholder ?? "Search"}
          aria-label="Search this list"
          className="min-h-11 min-w-56 flex-1 rounded-md border border-steel-300 bg-white px-3 text-sm"
        />
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-md border border-steel-300 bg-white px-4 text-sm font-medium text-steel-700 hover:bg-steel-50"
        >
          Search
        </button>
        {query.q && (
          <Link
            href={href({ q: "" })}
            className="inline-flex min-h-11 items-center rounded-md border border-steel-300 bg-white px-4 text-sm text-steel-600 hover:bg-steel-50"
          >
            Clear
          </Link>
        )}
      </form>

      {page.total === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={
              query.q
                ? `Nothing matches “${query.q}”`
                : (empty?.title ?? "Nothing to show")
            }
            hint={query.q ? "Try a shorter search, or clear it." : empty?.hint}
          />
        </div>
      ) : (
        <Panel className="mt-4 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              {caption && <caption className="sr-only">{caption}</caption>}
              <thead className="bg-steel-50/60">
                <tr className="border-b border-steel-200">
                  {columns.map((c) => {
                    const active = query.sort === c.key;
                    const cls = `${TH} ${c.align === "right" ? "text-right" : ""} ${
                      c.secondary ? "hidden sm:table-cell" : ""
                    }`;
                    if (!c.sortable) {
                      return (
                        <th key={c.key} className={cls}>
                          {c.label}
                        </th>
                      );
                    }
                    return (
                      <th
                        key={c.key}
                        className={cls}
                        aria-sort={active ? (query.dir === "asc" ? "ascending" : "descending") : "none"}
                      >
                        <Link
                          href={href(nextSortFor(c.key, query))}
                          /* 44x44 is the W3C enhanced target. A short heading
                             like "Qty" is tall enough but far too narrow without
                             a minimum width, and these are tapped on a tablet. */
                          className={`inline-flex min-h-11 min-w-11 items-center gap-1 ${
                            c.align === "right" ? "justify-end" : ""
                          } ${active ? "text-navy-800" : "hover:text-steel-600"}`}
                        >
                          {c.label}
                          <span aria-hidden className={active ? "" : "text-steel-300"}>
                            {active ? (query.dir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </Link>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={rowKey(row)} className={TR}>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`${TD} ${c.align === "right" ? "text-right" : ""} ${
                          c.secondary ? "hidden sm:table-cell" : ""
                        }`}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* Where you are, and how to move */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="tnum text-xs text-steel-500">
          {page.total === 0
            ? "No rows"
            : `${page.from}–${page.to} of ${page.total}`}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-steel-400">Per page</span>
            {PER_PAGE_CHOICES.map((n) => (
              <Link
                key={n}
                href={href({ perPage: n })}
                aria-current={page.perPage === n ? "true" : undefined}
                className={`tnum inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-xs ${
                  page.perPage === n
                    ? "bg-navy-800 font-semibold text-white"
                    : "border border-steel-300 bg-white text-steel-600 hover:bg-steel-50"
                }`}
              >
                {n}
              </Link>
            ))}
          </div>

          {page.pageCount > 1 && (
            <div className="flex items-center gap-1.5">
              <PageLink href={href({ page: page.page - 1 })} disabled={page.page <= 1}>
                Previous
              </PageLink>
              <span className="tnum px-1 text-xs text-steel-500">
                {page.page} / {page.pageCount}
              </span>
              <PageLink
                href={href({ page: page.page + 1 })}
                disabled={page.page >= page.pageCount}
              >
                Next
              </PageLink>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const base =
    "inline-flex min-h-11 items-center rounded-md border px-3 text-xs font-medium transition-colors";
  if (disabled) {
    return (
      <span aria-disabled className={`${base} border-steel-200 bg-steel-50 text-steel-300`}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={`${base} border-steel-300 bg-white text-steel-600 hover:bg-steel-50`}>
      {children}
    </Link>
  );
}
