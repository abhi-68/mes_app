/**
 * What each role needs to see the moment they sign in.
 *
 * Three different jobs, three different first screens. A worker needs to know
 * what to pick up next; a supervisor needs to know what is stuck and who is
 * free; an admin needs to know what is not set up yet. Giving all three the same
 * plant overview means none of them gets an answer without clicking.
 *
 * Everything here is derived. Nothing on a home screen is a number somebody has
 * to remember to keep up to date, because that is the first thing that rots.
 */
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  workOrders,
  workOrderTasks,
  timeEntries,
  users,
  stations,
  items,
  routingSteps,
  bomLines,
  inventoryBalances,
  inventoryLocations,
} from "@/db/schema";
import { blockersForOperations, type Blocker } from "@/lib/dependencies";
import type { SessionUser } from "@/lib/session";

const OPEN_STATUSES = ["PENDING", "IN_PROGRESS", "BLOCKED"] as const;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export type WorkerStep = {
  id: number;
  name: string;
  orderNumber: string;
  itemName: string;
  workOrderId: number;
  stationName: string | null;
  status: string;
  expectedMinutes: number | null;
  dueDate: Date | null;
  assignedToMe: boolean;
  openSince: Date | null;
  blockers: Blocker[];
};

export type WorkerHome = {
  stationName: string | null;
  /** What they are clocked on to right now. More than one means shared time. */
  running: WorkerStep[];
  /** Given to them by name and not yet started. */
  mine: WorkerStep[];
  /** At their station, nobody's name on it, nothing in the way. */
  ready: WorkerStep[];
  /** At their station but waiting on something. Shown so they stop asking. */
  waiting: WorkerStep[];
  blockedHere: WorkerStep[];
};

export async function workerHome(user: SessionUser): Promise<WorkerHome> {
  const station = user.stationId
    ? await db.query.stations.findFirst({ where: eq(stations.id, user.stationId) })
    : null;

  const rows = await db.query.workOrderTasks.findMany({
    where: and(
      inArray(workOrderTasks.status, [...OPEN_STATUSES]),
      user.stationId
        ? sql`(${workOrderTasks.stationId} = ${user.stationId} or ${workOrderTasks.assignedToUserId} = ${user.id})`
        : eq(workOrderTasks.assignedToUserId, user.id)
    ),
    with: { station: true, workOrder: { with: { item: true } } },
    orderBy: [asc(workOrderTasks.sequence)],
  });

  const open = await db
    .select({ taskId: timeEntries.workOrderTaskId, startedAt: timeEntries.startedAt })
    .from(timeEntries)
    .where(and(eq(timeEntries.userId, user.id), isNull(timeEntries.endedAt)));
  const openByTask = new Map(open.map((e) => [e.taskId, e.startedAt]));

  const blockerMap = await blockersForOperations(rows.map((r) => r.id));

  const steps: WorkerStep[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    orderNumber: t.workOrder.orderNumber,
    itemName: t.workOrder.item.name,
    workOrderId: t.workOrderId,
    stationName: t.station?.name ?? null,
    status: t.status,
    expectedMinutes: t.expectedMinutes,
    dueDate: t.workOrder.dueDate,
    assignedToMe: t.assignedToUserId === user.id,
    openSince: openByTask.get(t.id) ?? null,
    blockers: blockerMap.get(t.id) ?? [],
  }));

  // Soonest due first. A step with no due date sorts last rather than first,
  // which is what an undated placeholder would otherwise do to the queue.
  const byUrgency = (a: WorkerStep, b: WorkerStep) =>
    (a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER);

  const running = steps.filter((s) => s.openSince).sort(byUrgency);
  const rest = steps.filter((s) => !s.openSince);

  return {
    stationName: station?.name ?? null,
    running,
    mine: rest.filter((s) => s.assignedToMe && s.status !== "BLOCKED").sort(byUrgency),
    ready: rest
      .filter((s) => !s.assignedToMe && s.status !== "BLOCKED" && s.blockers.length === 0)
      .sort(byUrgency),
    waiting: rest
      .filter((s) => !s.assignedToMe && s.status !== "BLOCKED" && s.blockers.length > 0)
      .sort(byUrgency),
    blockedHere: rest.filter((s) => s.status === "BLOCKED").sort(byUrgency),
  };
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export type BlockedStep = {
  id: number;
  name: string;
  workOrderId: number;
  orderNumber: string;
  itemName: string;
  stationName: string | null;
  reason: string | null;
  note: string | null;
  /**
   * Minutes since it was flagged, or null when no BLOCKED event exists — data
   * loaded straight into the database, for instance. Saying "stopped 0m ago"
   * about something that has been stuck since yesterday is worse than saying
   * nothing, because a supervisor triages on age.
   */
  ageMinutes: number | null;
  raisedBy: string | null;
};

export type OverdueStep = {
  id: number;
  name: string;
  workOrderId: number;
  orderNumber: string;
  itemName: string;
  stationName: string | null;
  expectedMinutes: number | null;
  elapsedMinutes: number;
  who: string | null;
};

export type StationLoad = {
  stationId: number | null;
  stationName: string;
  open: number;
  running: number;
  blocked: number;
  unassigned: number;
  peopleOnShift: number;
};

export type SupervisorHome = {
  blocked: BlockedStep[];
  overdue: OverdueStep[];
  load: StationLoad[];
  /** Steps nobody has picked up and nobody has been given. The assign list. */
  needsSomeone: number;
  openUnits: number;
};

export async function supervisorHome(): Promise<SupervisorHome> {
  const now = Date.now();

  const blockedRows = await db.query.workOrderTasks.findMany({
    where: eq(workOrderTasks.status, "BLOCKED"),
    with: {
      station: true,
      blockedReason: true,
      workOrder: { with: { item: true } },
      events: true,
    },
  });

  const blocked: BlockedStep[] = blockedRows
    .map((t) => {
      // When it was flagged, not when the order was created. The last BLOCKED
      // event is the moment work actually stopped.
      const flagged = [...t.events]
        .filter((e) => e.type === "BLOCKED")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return {
        id: t.id,
        name: t.name,
        workOrderId: t.workOrderId,
        orderNumber: t.workOrder.orderNumber,
        itemName: t.workOrder.item.name,
        stationName: t.station?.name ?? null,
        reason: t.blockedReason?.label ?? null,
        note: t.blockedNote,
        ageMinutes: flagged
          ? Math.max(0, Math.round((now - flagged.createdAt.getTime()) / 60_000))
          : null,
        raisedBy: null as string | null,
      };
    })
    // Oldest first; an unknown age sorts last rather than pretending to be new.
    .sort((a, b) => (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1));

  // Name the person who flagged it, in one query rather than one per row.
  if (blocked.length > 0) {
    const actorIds = blockedRows
      .flatMap((t) => t.events.filter((e) => e.type === "BLOCKED").map((e) => e.actorUserId))
      .filter((id): id is number => id !== null);
    if (actorIds.length > 0) {
      const people = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, [...new Set(actorIds)]));
      const nameById = new Map(people.map((p) => [p.id, p.name]));
      for (const b of blocked) {
        const row = blockedRows.find((t) => t.id === b.id)!;
        const last = [...row.events]
          .filter((e) => e.type === "BLOCKED")
          .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
        b.raisedBy = last?.actorUserId ? (nameById.get(last.actorUserId) ?? null) : null;
      }
    }
  }

  // Overrunning: still in progress and past twice its estimate. Same rule the
  // alert feed uses, so the two screens cannot disagree.
  const runningRows = await db.query.workOrderTasks.findMany({
    where: eq(workOrderTasks.status, "IN_PROGRESS"),
    with: {
      station: true,
      workOrder: { with: { item: true } },
      timeEntries: { with: { user: true } },
    },
  });

  const overdue: OverdueStep[] = runningRows
    .map((t) => {
      const openEntry = t.timeEntries.find((e) => e.endedAt === null);
      const logged = t.timeEntries.reduce((s, e) => s + (e.durationSeconds ?? 0), 0);
      const liveSeconds = openEntry
        ? Math.round((now - openEntry.startedAt.getTime()) / 1000)
        : 0;
      return {
        id: t.id,
        name: t.name,
        workOrderId: t.workOrderId,
        orderNumber: t.workOrder.orderNumber,
        itemName: t.workOrder.item.name,
        stationName: t.station?.name ?? null,
        expectedMinutes: t.expectedMinutes,
        elapsedMinutes: Math.round((logged + liveSeconds) / 60),
        who: openEntry?.user.name ?? null,
      };
    })
    .filter((r) => r.expectedMinutes != null && r.elapsedMinutes > r.expectedMinutes * 2)
    .sort((a, b) => b.elapsedMinutes - a.elapsedMinutes);

  // Station workload.
  const allStations = await db.select().from(stations).where(eq(stations.active, true));
  const openSteps = await db
    .select({
      id: workOrderTasks.id,
      stationId: workOrderTasks.stationId,
      status: workOrderTasks.status,
      assignedToUserId: workOrderTasks.assignedToUserId,
    })
    .from(workOrderTasks)
    .where(inArray(workOrderTasks.status, [...OPEN_STATUSES]));

  const onShift = await db
    .select({ userId: timeEntries.userId, stationId: users.stationId })
    .from(timeEntries)
    .innerJoin(users, eq(timeEntries.userId, users.id))
    .where(isNull(timeEntries.endedAt));

  const load: StationLoad[] = allStations
    .map((s) => {
      const mine = openSteps.filter((t) => t.stationId === s.id);
      return {
        stationId: s.id,
        stationName: s.name,
        open: mine.length,
        running: mine.filter((t) => t.status === "IN_PROGRESS").length,
        blocked: mine.filter((t) => t.status === "BLOCKED").length,
        unassigned: mine.filter((t) => t.assignedToUserId === null && t.status === "PENDING")
          .length,
        peopleOnShift: new Set(
          onShift.filter((p) => p.stationId === s.id).map((p) => p.userId)
        ).size,
      };
    })
    .sort((a, b) => b.blocked - a.blocked || b.open - a.open);

  const unstationed = openSteps.filter((t) => t.stationId === null);
  if (unstationed.length > 0) {
    load.push({
      stationId: null,
      stationName: "No station set",
      open: unstationed.length,
      running: unstationed.filter((t) => t.status === "IN_PROGRESS").length,
      blocked: unstationed.filter((t) => t.status === "BLOCKED").length,
      unassigned: unstationed.filter((t) => t.assignedToUserId === null).length,
      peopleOnShift: 0,
    });
  }

  const openUnitRows = await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(
      and(
        isNull(workOrders.parentWorkOrderId),
        ne(workOrders.status, "DONE"),
        ne(workOrders.status, "CANCELLED")
      )
    );

  return {
    blocked,
    overdue,
    load,
    needsSomeone: openSteps.filter(
      (t) => t.assignedToUserId === null && t.status === "PENDING"
    ).length,
    openUnits: openUnitRows.length,
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type SetupGap = {
  key: string;
  title: string;
  detail: string;
  count: number;
  href: string;
};

export type AdminHome = {
  awaitingRelease: {
    id: number;
    orderNumber: string;
    itemName: string;
    quantity: number;
    dueDate: Date | null;
    customerName: string | null;
  }[];
  gaps: SetupGap[];
  stockExceptions: {
    itemId: number;
    sku: string;
    name: string;
    uom: string;
    free: number;
    reorderPoint: number;
    held: number;
  }[];
  counts: { people: number; products: number; stations: number; openOrders: number };
};

export async function adminHome(): Promise<AdminHome> {
  const planned = await db.query.workOrders.findMany({
    where: eq(workOrders.status, "PLANNED"),
    with: { item: true, customer: true },
    orderBy: [asc(workOrders.dueDate), desc(workOrders.createdAt)],
    limit: 10,
  });

  // --- setup gaps: things that will fail later, found now -------------------
  const gaps: SetupGap[] = [];

  const manufactured = await db
    .select({ id: items.id, sku: items.sku, name: items.name })
    .from(items)
    .where(and(eq(items.active, true), eq(items.procurementType, "MANUFACTURED")));

  const withRouting = new Set(
    (
      await db
        .selectDistinct({ itemId: routingSteps.itemId })
        .from(routingSteps)
    ).map((r) => r.itemId)
  );
  const noRouting = manufactured.filter((i) => !withRouting.has(i.id));
  if (noRouting.length > 0) {
    gaps.push({
      key: "no-routing",
      title: `${noRouting.length} product${noRouting.length === 1 ? "" : "s"} with no steps`,
      detail: `A work order for ${noRouting
        .slice(0, 3)
        .map((i) => i.name)
        .join(", ")}${noRouting.length > 3 ? " and others" : ""} would release with nothing for anyone to do.`,
      count: noRouting.length,
      href: "/admin/products",
    });
  }

  const withBom = new Set(
    (await db.selectDistinct({ parentItemId: bomLines.parentItemId }).from(bomLines)).map(
      (r) => r.parentItemId
    )
  );
  const noBom = manufactured.filter((i) => !withBom.has(i.id));
  if (noBom.length > 0) {
    gaps.push({
      key: "no-bom",
      title: `${noBom.length} product${noBom.length === 1 ? "" : "s"} with no parts list`,
      detail:
        "Nothing will be reserved or issued for these, so the floor will never be told a part is short.",
      count: noBom.length,
      href: "/admin/products",
    });
  }

  const stationless = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.active, true), eq(users.role, "WORKER"), isNull(users.stationId)));
  if (stationless.length > 0) {
    gaps.push({
      key: "no-station",
      title: `${stationless.length} worker${stationless.length === 1 ? "" : "s"} with no station`,
      detail: `${stationless
        .slice(0, 3)
        .map((u) => u.name)
        .join(", ")} will sign in to an empty screen and cannot start anything.`,
      count: stationless.length,
      href: "/admin/people",
    });
  }

  const stepsWithoutStation = await db
    .select({ id: routingSteps.id })
    .from(routingSteps)
    .where(isNull(routingSteps.stationId));
  if (stepsWithoutStation.length > 0) {
    gaps.push({
      key: "step-no-station",
      title: `${stepsWithoutStation.length} step${stepsWithoutStation.length === 1 ? "" : "s"} not tied to a station`,
      detail: "These appear on nobody's screen until someone picks them out of the order.",
      count: stepsWithoutStation.length,
      href: "/admin/products",
    });
  }

  const locations = await db.select({ id: inventoryLocations.id }).from(inventoryLocations);
  if (locations.length === 0) {
    gaps.push({
      key: "no-location",
      title: "No stock location configured",
      detail: "Material cannot be received or issued at all until one exists.",
      count: 1,
      href: "/inventory",
    });
  }

  const noReorder = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.active, true), eq(items.procurementType, "PURCHASED"), eq(items.reorderPoint, 0)));
  if (noReorder.length > 0) {
    gaps.push({
      key: "no-reorder",
      title: `${noReorder.length} bought part${noReorder.length === 1 ? "" : "s"} with no reorder point`,
      detail: "Nothing will warn you before these run out — the shortage shows up as a blocked step.",
      count: noReorder.length,
      href: "/inventory",
    });
  }

  // --- stock exceptions -----------------------------------------------------
  const balanceRows = await db
    .select({
      itemId: items.id,
      sku: items.sku,
      name: items.name,
      uom: items.unitOfMeasure,
      reorderPoint: items.reorderPoint,
      onHand: inventoryBalances.onHand,
      reserved: inventoryBalances.activeReserved,
      held: inventoryBalances.heldQty,
    })
    .from(items)
    .leftJoin(inventoryBalances, eq(inventoryBalances.itemId, items.id))
    .where(eq(items.active, true));

  const byItem = new Map<
    number,
    { sku: string; name: string; uom: string; reorderPoint: number; free: number; held: number }
  >();
  for (const r of balanceRows) {
    const cur = byItem.get(r.itemId) ?? {
      sku: r.sku,
      name: r.name,
      uom: r.uom,
      reorderPoint: r.reorderPoint,
      free: 0,
      held: 0,
    };
    cur.free += (r.onHand ?? 0) - (r.reserved ?? 0) - (r.held ?? 0);
    cur.held += r.held ?? 0;
    byItem.set(r.itemId, cur);
  }

  const stockExceptions = [...byItem.entries()]
    .map(([itemId, v]) => ({ itemId, ...v }))
    .filter((v) => (v.reorderPoint > 0 && v.free <= v.reorderPoint) || v.free < 0 || v.held > 0)
    .sort((a, b) => a.free - b.free)
    .slice(0, 8);

  const [people, products, stationRows, openOrders] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.active, true)),
    db.select({ id: items.id }).from(items).where(eq(items.active, true)),
    db.select({ id: stations.id }).from(stations).where(eq(stations.active, true)),
    db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(isNotNull(workOrders.id), ne(workOrders.status, "DONE"), ne(workOrders.status, "CANCELLED"))),
  ]);

  return {
    awaitingRelease: planned.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      itemName: o.item.name,
      quantity: o.quantity,
      dueDate: o.dueDate,
      customerName: o.customer?.name ?? null,
    })),
    gaps,
    stockExceptions,
    counts: {
      people: people.length,
      products: products.length,
      stations: stationRows.length,
      openOrders: openOrders.length,
    },
  };
}
