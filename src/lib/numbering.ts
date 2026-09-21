import { sql } from "drizzle-orm";
import type { Exec } from "@/lib/inventory";
import { db } from "@/db";

/**
 * Document numbers.
 *
 * Orders run on ONE counter that never resets: `ORD-0001`, `ORD-0002`. Short
 * enough to read aloud across a noisy shop, and the same number tomorrow as it
 * was today — a counter that restarts daily makes "order 1" ambiguous the moment
 * somebody says it out loud a day later.
 *
 * Delivery notes keep the dated form, because they are filed by the day they went
 * out and nobody reads one back over the radio.
 *
 * Numbers are allocated under an advisory lock, because `max + 1` read outside a
 * lock hands the same number to two people raising an order in the same second.
 * The lock is transaction-scoped, so the commit that writes the row releases it.
 */

export function dateStamp(when: Date = new Date()): string {
  const yy = String(when.getFullYear() % 100).padStart(2, "0");
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  const dd = String(when.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Highest suffix already used today, given the numbers on record. */
export function nextSuffix(head: string, taken: string[]): number {
  const used = taken
    .filter((n) => n.startsWith(head))
    .map((n) => Number(n.slice(head.length).split("-")[0]))
    .filter((n) => Number.isFinite(n));
  return (used.length > 0 ? Math.max(...used) : 0) + 1;
}

/**
 * Allocate the next number for `prefix` from `table`.`column`.
 *
 * `table` and `column` are identifiers supplied by this codebase, never by a
 * request — they are interpolated as raw SQL, so they must stay that way.
 */
export async function nextDocumentNumber(
  prefix: string,
  table: string,
  column: string,
  exec: Exec = {}
): Promise<string> {
  const database = exec.tx ?? exec.db ?? db;
  const stamp = dateStamp();
  const head = `${prefix}-${stamp}-`;

  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${prefix}:${stamp}`}, 0))`
  );

  const result = await database.execute(
    sql`select ${sql.raw(`"${column}"`)} as n from ${sql.raw(`"${table}"`)}
        where ${sql.raw(`"${column}"`)} like ${`${head}%`}`
  );
  const taken = (result.rows as { n: string }[]).map((r) => r.n);
  return `${head}${String(nextSuffix(head, taken)).padStart(3, "0")}`;
}

/**
 * The next order number, `ORD-0001`. Call inside the transaction that inserts it.
 *
 * Counts only top-level orders: a sub-assembly is numbered from its parent
 * (`ORD-0001-01`) and must not consume a number of its own, or the series
 * develops gaps nobody can explain.
 */
export async function nextWorkOrderNumber(exec: Exec = {}): Promise<string> {
  const database = exec.tx ?? exec.db ?? db;
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended('ORD', 0))`);

  const result = await database.execute(
    sql`select "order_number" as n from "work_orders" where "order_number" like 'ORD-%'`
  );
  const used = (result.rows as { n: string }[])
    .map((r) => /^ORD-(\d+)$/.exec(r.n)?.[1])
    .filter((v): v is string => Boolean(v))
    .map(Number);
  const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
  return `ORD-${String(next).padStart(4, "0")}`;
}

/**
 * What a job is called: the order number and the station it runs at.
 *
 * `taken` is every job number already on this order, so a routing that visits one
 * station twice produces ORD-0001-20 and ORD-0001-20-2 rather than the same
 * number twice.
 */
export function jobNumberFor(
  orderNumber: string,
  stationNumber: number | null,
  taken: Iterable<string>
): string {
  if (stationNumber === null) return orderNumber;
  const base = `${orderNumber}-${String(stationNumber).padStart(2, "0")}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}
