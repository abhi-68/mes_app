import { inArray, notInArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { stations, workOrders, workOrderTasks, operationDependencies } from "@/db/schema";
import type { Exec } from "@/lib/inventory";
import {
  computeSchedule,
  lateRootCauses,
  DEFAULT_CALENDAR,
  type Schedule,
  type SchedulableEdge,
  type SchedulableOrder,
  type SchedulableTask,
  type LateRootCause,
} from "@/lib/schedule";

/**
 * Loads the whole floor and schedules it.
 *
 * PLANT-WIDE ON PURPOSE. A schedule for one order alone would give that order
 * every machine in the building and promise a date it cannot hold. Capacity only
 * means something when every open job is competing for it, so this loads all live
 * work and callers take their slice afterwards.
 */
export type PlantSchedule = {
  schedule: Schedule;
  tasks: SchedulableTask[];
  edges: SchedulableEdge[];
  /** Needed-by date per work order, derived from the backward pass. */
  neededBy: Map<number, Date>;
};

export async function scheduleOpenWork(
  now: Date = new Date(),
  exec: Exec = {}
): Promise<PlantSchedule> {
  const database = exec.tx ?? exec.db ?? defaultDb;

  const liveOrders = await database
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      dueDate: workOrders.dueDate,
      parentWorkOrderId: workOrders.parentWorkOrderId,
    })
    .from(workOrders)
    .where(notInArray(workOrders.status, ["DONE", "CANCELLED"]));

  if (liveOrders.length === 0) {
    return {
      schedule: { computedAt: now, tasks: new Map(), orders: new Map(), guessedDurations: 0 },
      tasks: [],
      edges: [],
      neededBy: new Map(),
    };
  }

  // A sub-assembly is due when the unit it feeds is due, so every order in a tree
  // is scheduled against the top-level order's date.
  const parentOf = new Map(liveOrders.map((o) => [o.id, o.parentWorkOrderId]));
  const rootOf = (id: number): number => {
    let current = id;
    for (let i = 0; i < 20; i++) {
      const parent = parentOf.get(current);
      if (parent == null) return current;
      current = parent;
    }
    return current;
  };

  const orders: SchedulableOrder[] = liveOrders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    dueDate: o.dueDate,
    rootOrderId: rootOf(o.id),
  }));

  const orderIds = liveOrders.map((o) => o.id);
  const rows = await database
    .select({
      id: workOrderTasks.id,
      workOrderId: workOrderTasks.workOrderId,
      stationId: workOrderTasks.stationId,
      expectedMinutes: workOrderTasks.expectedMinutes,
      status: workOrderTasks.status,
      startedAt: workOrderTasks.startedAt,
      completedAt: workOrderTasks.completedAt,
      sequence: workOrderTasks.sequence,
    })
    .from(workOrderTasks)
    .where(inArray(workOrderTasks.workOrderId, orderIds));

  const tasks: SchedulableTask[] = rows.map((r) => ({
    id: r.id,
    workOrderId: r.workOrderId,
    stationId: r.stationId,
    expectedMinutes: r.expectedMinutes,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    sequence: r.sequence,
  }));

  const taskIds = tasks.map((t) => t.id);
  const deps =
    taskIds.length > 0
      ? await database
          .select({
            operationId: operationDependencies.operationId,
            dependsOnOperationId: operationDependencies.dependsOnOperationId,
          })
          .from(operationDependencies)
          .where(inArray(operationDependencies.operationId, taskIds))
      : [];

  // REQUIRED_QUANTITY and QUALITY_ACCEPTANCE both point at the same predecessor.
  // For timing they are one edge.
  const seen = new Set<string>();
  const edges: SchedulableEdge[] = [];
  for (const d of deps) {
    if (d.dependsOnOperationId == null) continue;
    const key = `${d.operationId}:${d.dependsOnOperationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ taskId: d.operationId, dependsOnTaskId: d.dependsOnOperationId });
  }

  const stationRows = await database
    .select({ id: stations.id, capacity: stations.capacity })
    .from(stations);
  const stationCapacity = new Map(stationRows.map((s) => [s.id, s.capacity]));

  const schedule = computeSchedule({ tasks, orders, edges, stationCapacity, now });

  // A sub-assembly's real deadline is when its LAST step has to finish for the
  // unit to stay on time. Derived, so it can never contradict the parent — unlike
  // the copied-down date it replaces.
  const lastTaskOf = new Map<number, SchedulableTask>();
  for (const t of tasks) {
    const current = lastTaskOf.get(t.workOrderId);
    if (!current || t.sequence > current.sequence) lastTaskOf.set(t.workOrderId, t);
  }
  const neededBy = new Map<number, Date>();
  for (const [orderId, t] of lastTaskOf) {
    const scheduled = schedule.tasks.get(t.id);
    if (scheduled) neededBy.set(orderId, scheduled.latestFinish);
  }

  return { schedule, tasks, edges, neededBy };
}

export function plantLateCauses(plant: PlantSchedule, now: Date = new Date()): LateRootCause[] {
  return lateRootCauses(plant.schedule, plant.tasks, plant.edges, now, DEFAULT_CALENDAR);
}
