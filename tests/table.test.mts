import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PER_PAGE, nextSortFor, paginate, readTableQuery, sortRows, tableHref,
} from "../src/lib/table.ts";

/**
 * List plumbing. Pure functions, no database — these are the rules every list
 * screen shares, and the edge cases (a page past the end, a sort column supplied
 * from the address bar, an empty value in a sorted column) are the ones that
 * quietly show somebody the wrong rows.
 */

const SORTABLE = ["number", "qty", "due"] as const;
const read = (params: Record<string, string | string[] | undefined>) =>
  readTableQuery(params, { sortable: SORTABLE });

// --- reading the URL -----------------------------------------------------

test("an empty query is the sane default", () => {
  const q = read({});
  assert.deepEqual(q, { q: "", filter: "all", sort: null, dir: "asc", page: 1, perPage: DEFAULT_PER_PAGE });
});

test("a sort column not on the allow-list is ignored", () => {
  assert.equal(read({ sort: "qty" }).sort, "qty");
  assert.equal(read({ sort: "password" }).sort, null, "the address bar is not trusted");
  assert.equal(read({ sort: "" }).sort, null);
});

test("per page is one of the offered choices or the default", () => {
  assert.equal(read({ perPage: "25" }).perPage, 25);
  assert.equal(read({ perPage: "10000" }).perPage, DEFAULT_PER_PAGE, "no unbounded page size");
  assert.equal(read({ perPage: "-1" }).perPage, DEFAULT_PER_PAGE);
  assert.equal(read({ perPage: "abc" }).perPage, DEFAULT_PER_PAGE);
});

test("page is a positive whole number", () => {
  assert.equal(read({ page: "3" }).page, 3);
  for (const bad of ["0", "-2", "1.5", "abc", ""]) assert.equal(read({ page: bad }).page, 1);
});

test("direction is only asc or desc", () => {
  assert.equal(read({ sort: "qty", dir: "desc" }).dir, "desc");
  assert.equal(read({ sort: "qty", dir: "sideways" }).dir, "asc");
});

test("repeated parameters take the first, not an array", () => {
  assert.equal(read({ q: ["motor", "pump"] }).q, "motor");
});

// --- building URLs -------------------------------------------------------

test("the default view has a clean address", () => {
  assert.equal(tableHref("/orders", read({}), {}), "/orders");
});

test("only what differs from the default appears in the URL", () => {
  const q = read({});
  assert.equal(tableHref("/orders", q, { q: "WO-1001" }), "/orders?q=WO-1001");
  assert.equal(tableHref("/orders", q, { filter: "open" }), "/orders?filter=open");
  assert.equal(tableHref("/orders", q, { filter: "all" }), "/orders");
  assert.equal(tableHref("/orders", q, { perPage: DEFAULT_PER_PAGE }), "/orders");
  assert.equal(tableHref("/orders", q, { perPage: 25 }), "/orders?perPage=25");
});

test("searching or filtering returns to page one", () => {
  const onPage4 = read({ page: "4" });
  assert.equal(tableHref("/orders", onPage4, { q: "motor" }), "/orders?q=motor");
  assert.equal(tableHref("/orders", onPage4, { filter: "open" }), "/orders?filter=open");
  assert.equal(tableHref("/orders", onPage4, { perPage: "25" as unknown as number }).includes("page"), false);
  // Paging itself obviously keeps the page.
  assert.equal(tableHref("/orders", onPage4, { page: 5 }), "/orders?page=5");
});

test("search and filter survive a sort, and each other", () => {
  const q = read({ q: "motor", filter: "open" });
  const href = tableHref("/orders", q, nextSortFor("qty", q));
  assert.match(href, /q=motor/);
  assert.match(href, /filter=open/);
  assert.match(href, /sort=qty/);
});

test("clicking a column flips it, a different column starts ascending", () => {
  const base = read({});
  assert.deepEqual(nextSortFor("qty", base), { sort: "qty", dir: "asc" });
  const onQtyAsc = read({ sort: "qty", dir: "asc" });
  assert.deepEqual(nextSortFor("qty", onQtyAsc), { sort: "qty", dir: "desc" });
  assert.deepEqual(nextSortFor("due", onQtyAsc), { sort: "due", dir: "asc" });
});

// --- sorting -------------------------------------------------------------

type Row = { n: string; qty: number | null; due: Date | null };
const rows: Row[] = [
  { n: "WO-2", qty: 10, due: new Date("2026-03-01") },
  { n: "WO-10", qty: 2, due: null },
  { n: "WO-1", qty: null, due: new Date("2026-01-01") },
];
const valueOf = (r: Row, c: string) => (c === "n" ? r.n : c === "qty" ? r.qty : r.due);

test("no sort leaves the rows exactly as given", () => {
  assert.deepEqual(sortRows(rows, null, "asc", valueOf), rows);
});

test("numbers sort as numbers", () => {
  assert.deepEqual(sortRows(rows, "qty", "asc", valueOf).map((r) => r.qty), [2, 10, null]);
  assert.deepEqual(sortRows(rows, "qty", "desc", valueOf).map((r) => r.qty), [10, 2, null]);
});

test("order numbers sort naturally, so WO-2 comes before WO-10", () => {
  assert.deepEqual(sortRows(rows, "n", "asc", valueOf).map((r) => r.n), ["WO-1", "WO-2", "WO-10"]);
});

test("dates sort by time, not by their text", () => {
  assert.deepEqual(
    sortRows(rows, "due", "asc", valueOf).map((r) => r.n),
    ["WO-1", "WO-2", "WO-10"]
  );
});

test("empty values sort last in BOTH directions", () => {
  // An unknown due date belongs at the bottom of a list someone is working down,
  // not at the top of it because null happens to be less than everything.
  assert.equal(sortRows(rows, "due", "asc", valueOf).at(-1)!.n, "WO-10");
  assert.equal(sortRows(rows, "due", "desc", valueOf).at(-1)!.n, "WO-10");
  assert.equal(sortRows(rows, "qty", "desc", valueOf).at(-1)!.qty, null);
});

test("sorting does not mutate the caller's array", () => {
  const original = [...rows];
  sortRows(rows, "qty", "desc", valueOf);
  assert.deepEqual(rows, original);
});

// --- paging --------------------------------------------------------------

const many = Array.from({ length: 23 }, (_, i) => i + 1);

test("a page reports where it is in the whole list", () => {
  const p = paginate(many, 1, 10);
  assert.deepEqual(p.rows, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(p.total, 23);
  assert.equal(p.pageCount, 3);
  assert.equal(p.from, 1);
  assert.equal(p.to, 10);
});

test("the last page is short, not padded", () => {
  const p = paginate(many, 3, 10);
  assert.deepEqual(p.rows, [21, 22, 23]);
  assert.equal(p.from, 21);
  assert.equal(p.to, 23);
});

test("a page past the end shows the last page rather than nothing", () => {
  // Deleting rows while someone is on page 9 must not strand them on a blank screen.
  const p = paginate(many, 99, 10);
  assert.equal(p.page, 3);
  assert.deepEqual(p.rows, [21, 22, 23]);
});

test("an empty list is one empty page, counted from zero", () => {
  const p = paginate([], 1, 10);
  assert.deepEqual(p.rows, []);
  assert.equal(p.total, 0);
  assert.equal(p.pageCount, 1);
  assert.equal(p.from, 0);
  assert.equal(p.to, 0);
});
