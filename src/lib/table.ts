/**
 * List-screen plumbing: search, filter, sort, paginate — all in the URL.
 *
 * Everything here is pure and server-side. A filtered, sorted page is then a real
 * address that can be bookmarked, reloaded, and read out over the radio, and the
 * screens need no client-side state to manage. It also means one set of rules for
 * every list instead of each page inventing its own.
 */

export const PER_PAGE_CHOICES = [5, 10, 25, 50] as const;
export const DEFAULT_PER_PAGE = 10;

export type SortDirection = "asc" | "desc";

export type TableQuery = {
  q: string;
  filter: string;
  sort: string | null;
  dir: SortDirection;
  page: number;
  perPage: number;
};

type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Read the query out of the URL, clamped to something sane.
 *
 * Every value here arrives from the address bar, so each one is validated rather
 * than trusted: an unknown sort column becomes no sort, a per-page of 10000
 * becomes the largest offered choice, and page 0 or -3 becomes page 1.
 */
export function readTableQuery(
  params: RawParams,
  options: { sortable?: readonly string[]; defaultSort?: string; defaultDir?: SortDirection } = {}
): TableQuery {
  const sortable = options.sortable ?? [];
  const rawSort = first(params.sort);
  const sort = sortable.includes(rawSort) ? rawSort : (options.defaultSort ?? null);

  const rawDir = first(params.dir);
  const dir: SortDirection =
    rawDir === "asc" || rawDir === "desc" ? rawDir : (options.defaultDir ?? "asc");

  const rawPer = Number(first(params.perPage));
  const perPage = PER_PAGE_CHOICES.includes(rawPer as (typeof PER_PAGE_CHOICES)[number])
    ? rawPer
    : DEFAULT_PER_PAGE;

  const rawPage = Number(first(params.page));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  return {
    q: first(params.q).trim(),
    filter: first(params.filter) || "all",
    sort,
    dir,
    page,
    perPage,
  };
}

/** A URL for this list with some of the query changed. */
export function tableHref(
  basePath: string,
  query: TableQuery,
  changes: Partial<TableQuery> & { page?: number }
): string {
  const next = { ...query, ...changes };
  // Any change to what is being shown sends you back to the first page —
  // otherwise searching from page 4 lands on an empty page 4 of two results.
  if (changes.page === undefined && ("q" in changes || "filter" in changes || "perPage" in changes)) {
    next.page = 1;
  }

  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.filter && next.filter !== "all") sp.set("filter", next.filter);
  if (next.sort) sp.set("sort", next.sort);
  if (next.sort && next.dir !== "asc") sp.set("dir", next.dir);
  if (next.perPage !== DEFAULT_PER_PAGE) sp.set("perPage", String(next.perPage));
  if (next.page > 1) sp.set("page", String(next.page));

  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Clicking a column: same column flips direction, a new column starts ascending. */
export function nextSortFor(
  column: string,
  query: TableQuery
): { sort: string; dir: SortDirection } {
  if (query.sort !== column) return { sort: column, dir: "asc" };
  return { sort: column, dir: query.dir === "asc" ? "desc" : "asc" };
}

/**
 * Sort rows by a column's comparable value.
 *
 * Nulls always sort last whichever way the column is pointing — an empty due date
 * is "unknown", and unknowns belong at the bottom of a list someone is working
 * down, not at the top of it because null happens to be less than everything.
 */
export function sortRows<T>(
  rows: T[],
  sort: string | null,
  dir: SortDirection,
  valueOf: (row: T, column: string) => string | number | Date | null | undefined
): T[] {
  if (!sort) return rows;
  const factor = dir === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = valueOf(a, sort);
    const bv = valueOf(b, sort);
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    const an = av instanceof Date ? av.getTime() : av;
    const bn = bv instanceof Date ? bv.getTime() : bv;
    if (typeof an === "number" && typeof bn === "number") return (an - bn) * factor;
    return String(an).localeCompare(String(bn), undefined, { numeric: true }) * factor;
  });
}

export type Page<T> = {
  rows: T[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  from: number;
  to: number;
};

/** Cut one page out of the rows, correcting a page number past the end. */
export function paginate<T>(rows: T[], page: number, perPage: number): Page<T> {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * perPage;
  const slice = rows.slice(start, start + perPage);
  return {
    rows: slice,
    total,
    page: current,
    perPage,
    pageCount,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
