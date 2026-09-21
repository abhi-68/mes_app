import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dispositionRecords, taskEvents, timeEntries, workOrderTasks,
} from "@/db/schema";
import type { Exec } from "@/lib/inventory";

/**
 * What one person got done today.
 *
 * Counts, not durations. The clock is still recorded — it is simply not the
 * operator's business, and a screen that hands them an hours figure at the end of
 * a shift invites an argument about it that nobody on the floor can settle.
 */

export type ShiftSummary = {
  jobsDone: number;
  jobsStarted: number;
  unitsProduced: number;
  reworked: number;
  rejected: number;
  timesDown: number;
  stillRunning: number;
};

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function shiftSummaryFor(userId: number, exec: Exec = {}): Promise<ShiftSummary> {
  const database = exec.tx ?? exec.db ?? db;
  const since = startOfToday();

  const [done] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(workOrderTasks)
    .where(
      and(
        eq(workOrderTasks.completedByUserId, userId),
        gte(workOrderTasks.completedAt, since)
      )
    );

  // Events carry who did what, so starts and downs are counted from the record
  // rather than inferred from current status — a step started and then blocked
  // still counts as both.
  const events = await database
    .select({
      type: sql<string>`${taskEvents.type}::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(taskEvents)
    .where(and(eq(taskEvents.actorUserId, userId), gte(taskEvents.createdAt, since)))
    .groupBy(taskEvents.type);
  const eventCount = (t: string) => events.find((e) => e.type === t)?.n ?? 0;

  const dispositions = await database
    .select({
      kind: sql<string>`${dispositionRecords.kind}::text`,
      n: sql<number>`coalesce(sum(${dispositionRecords.quantity}), 0)::int`,
    })
    .from(dispositionRecords)
    .where(
      and(eq(dispositionRecords.actorUserId, userId), gte(dispositionRecords.createdAt, since))
    )
    .groupBy(dispositionRecords.kind);
  const disp = (k: string) => dispositions.find((d) => d.kind === k)?.n ?? 0;

  const [open] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(timeEntries)
    .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)));

  return {
    jobsDone: done?.n ?? 0,
    jobsStarted: eventCount("STARTED"),
    unitsProduced: disp("PRODUCED"),
    reworked: disp("REWORK"),
    rejected: disp("SCRAP"),
    timesDown: eventCount("BLOCKED"),
    stillRunning: open?.n ?? 0,
  };
}
