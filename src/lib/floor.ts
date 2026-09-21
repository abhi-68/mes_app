import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  items, stations, timeEntries, users, workOrders, workOrderTasks,
} from "@/db/schema";
import { blockersForOperations, type Blocker } from "@/lib/dependencies";

/**
 * The floor map — where every job physically is, right now.
 *
 * The customer's problem in one sentence: to find out where a job has got to,
 * someone walks the line and asks. `/waiting` answers "what is stuck"; this
 * answers the prior question nobody had a screen for — "what is sitting at each
 * station". Everything here is derived from task status and station, so it is
 * never keyed in and never disagrees with the work orders.
 */

export type FloorJob = {
  operationId: number;
  operationName: string;
  orderId: number;
  orderNumber: string;
  itemName: string;
  status: string;
  /** Held up by something outside its own routing — the ones worth chasing. */
  heldUp: boolean;
  blockers: Blocker[];
  assignedToName: string | null;
  operators: string[];
  startedAt: Date | null;
  dueDate: Date | null;
};

/**
 * What colour the station is, in the order a person reads them.
 *
 * Red beats orange beats green: a station with one held-up job and three running
 * is a station somebody has to walk to, and showing it as busy hides that.
 */
export type StationState = "BLOCKED" | "RUNNING" | "QUEUED" | "DONE" | "IDLE";

export type FloorStation = {
  id: number | null;
  name: string;
  /** Null when the plant runs a single line, which is the common case. */
  line: string | null;
  running: number;
  queued: number;
  blocked: number;
  doneToday: number;
  wip: number;
  state: StationState;
  jobs: FloorJob[];
};

const OPEN = ["PENDING", "IN_PROGRESS", "BLOCKED"] as const;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * One position along a line.
 *
 * Stations sharing a position run IN PARALLEL — four fabrication cells feeding the
 * same assembly are four stations at one stage, not four stages. Positions run in
 * sequence. This is the difference between a line and a list, and it is the whole
 * reason `sortOrder` is a number a person sets rather than an id.
 */
export type FloorStage = { position: number; stations: FloorStation[] };

/** The stages of one line, in the order the job travels along it. */
export type FloorLine = { name: string | null; stages: FloorStage[] };

export async function floorMap(): Promise<{
  stations: FloorStation[];
  lines: FloorLine[];
  totals: { running: number; queued: number; heldUp: number; doneToday: number; onTheClock: number };
}> {
  const [allStations, open, doneToday, clocks] = await Promise.all([
    db.select().from(stations).where(eq(stations.active, true))
      .orderBy(asc(stations.sortOrder), asc(stations.id)),
    db.select({
      id: workOrderTasks.id, name: workOrderTasks.name, stationId: workOrderTasks.stationId,
      status: workOrderTasks.status, startedAt: workOrderTasks.startedAt,
      orderId: workOrders.id, orderNumber: workOrders.orderNumber, dueDate: workOrders.dueDate,
      itemName: items.name, assignedToName: users.name,
    }).from(workOrderTasks)
      .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
      .innerJoin(items, eq(workOrders.itemId, items.id))
      .leftJoin(users, eq(workOrderTasks.assignedToUserId, users.id))
      .where(and(
        inArray(workOrderTasks.status, [...OPEN]),
        inArray(workOrders.status, ["RELEASED", "IN_PROGRESS"]),
      ))
      .orderBy(asc(workOrders.dueDate), asc(workOrderTasks.sequence)),
    db.select({
      stationId: workOrderTasks.stationId,
      n: sql<number>`count(*)::int`,
    }).from(workOrderTasks)
      .where(and(eq(workOrderTasks.status, "DONE"), gte(workOrderTasks.completedAt, startOfToday())))
      .groupBy(workOrderTasks.stationId),
    // Who is physically on the clock, and on what. An open entry is someone
    // standing at that station now — the difference between "assigned" and "here".
    db.select({ operationId: timeEntries.workOrderTaskId, name: users.name })
      .from(timeEntries).innerJoin(users, eq(timeEntries.userId, users.id))
      .where(isNull(timeEntries.endedAt)),
  ]);

  const blockers = await blockersForOperations(open.map((t) => t.id));

  const doneOf = new Map(doneToday.map((r) => [r.stationId, r.n]));
  const operatorsOf = new Map<number, string[]>();
  for (const c of clocks) {
    const list = operatorsOf.get(c.operationId);
    if (list) list.push(c.name);
    else operatorsOf.set(c.operationId, [c.name]);
  }

  const jobsByStation = new Map<number | null, FloorJob[]>();
  for (const t of open) {
    const list = blockers.get(t.id) ?? [];
    const job: FloorJob = {
      operationId: t.id, operationName: t.name, orderId: t.orderId,
      orderNumber: t.orderNumber, itemName: t.itemName, status: t.status,
      // A step queued behind its own predecessor is normal flow. Anything else
      // is someone waiting on another person, which is what deserves attention.
      heldUp: list.some((b) => b.kind !== "SEQUENCE"),
      blockers: list, assignedToName: t.assignedToName,
      operators: operatorsOf.get(t.id) ?? [], startedAt: t.startedAt, dueDate: t.dueDate,
    };
    const key = t.stationId;
    const bucket = jobsByStation.get(key);
    if (bucket) bucket.push(job);
    else jobsByStation.set(key, [job]);
  }

  const build = (id: number | null, name: string, line: string | null = null): FloorStation => {
    const jobs = jobsByStation.get(id) ?? [];
    const running = jobs.filter((j) => j.status === "IN_PROGRESS").length;
    const blocked = jobs.filter((j) => j.status === "BLOCKED" || j.heldUp).length;
    const queued = jobs.length - running - blocked;
    return {
      id, name, line,
      running, queued: Math.max(0, queued), blocked,
      doneToday: doneOf.get(id) ?? 0, wip: jobs.length,
      state:
        blocked > 0
          ? "BLOCKED"
          : running > 0
            ? "RUNNING"
            : jobs.length > 0
              ? // Work is sitting here waiting for somebody. That is not idle.
                "QUEUED"
              : (doneOf.get(id) ?? 0) > 0
                ? "DONE"
                : "IDLE",
      jobs,
    };
  };

  /**
   * Shown in the order the stations are configured, which is the order they were
   * set up in.
   *
   * Deriving the order from the routings was tried and does not work: this plant
   * is convergent, so sub-assemblies and the final assembly both start at
   * sequence 1 and no arithmetic on sequence numbers can tell you that Frame Fab
   * feeds Final Assembly. Configured order is the only thing here that actually
   * knows, and it is a thing a person can fix in Setup when it is wrong.
   */
  const built = allStations.map((s) => build(s.id, s.name, s.line));

  // Steps with no station at all would otherwise be invisible on a map of stations.
  const orphan = jobsByStation.get(null);
  if (orphan?.length) built.push(build(null, "No station assigned"));

  /**
   * Grouped by line, then by position within it.
   *
   * A plant with one line has one group with a null name, and a plant whose
   * stations all sit at different positions draws a single strip exactly as it
   * did before stages existed.
   */
  const order = new Map(allStations.map((s) => [s.id, s.sortOrder]));
  const lines: FloorLine[] = [];
  for (const station of built) {
    const key = station.line ?? null;
    let line = lines.find((l) => l.name === key);
    if (!line) {
      line = { name: key, stages: [] };
      lines.push(line);
    }
    const position = station.id === null ? Number.MAX_SAFE_INTEGER : order.get(station.id) ?? 0;
    const stage = line.stages.find((st) => st.position === position);
    if (stage) stage.stations.push(station);
    else line.stages.push({ position, stations: [station] });
  }
  for (const line of lines) line.stages.sort((a, b) => a.position - b.position);

  return {
    stations: built,
    lines,
    totals: {
      running: built.reduce((n, s) => n + s.running, 0),
      queued: built.reduce((n, s) => n + s.queued, 0),
      heldUp: built.reduce((n, s) => n + s.blocked, 0),
      doneToday: built.reduce((n, s) => n + s.doneToday, 0),
      onTheClock: new Set(clocks.map((c) => c.name)).size,
    },
  };
}
