# Source: src/db/schema.ts

Commit 32fe146. Reproduced as a document because the source archive has not been reaching the reviewer.

```ts
import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const roleEnum = pgEnum("role", ["WORKER", "SUPERVISOR", "ADMIN"]);

/** Make-vs-buy. MANUFACTURED items can spawn their own sub-assembly work order. */
export const procurementTypeEnum = pgEnum("procurement_type", ["MANUFACTURED", "PURCHASED"]);

export const workOrderStatusEnum = pgEnum("work_order_status", [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "DONE",
  "ON_HOLD",
  "CANCELLED",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "PENDING",
  "IN_PROGRESS",
  "DONE",
  "BLOCKED",
]);

export const taskEventTypeEnum = pgEnum("task_event_type", [
  "STARTED",
  "COMPLETED",
  "BLOCKED",
  "UNBLOCKED",
  "REOPENED",
  "NOTE",
  "QUALITY",
  "EXTERNAL_EVENT",
]);

export const eventSourceEnum = pgEnum("event_source", ["HUMAN", "API"]);

/** Admin-editable reason code buckets. */
export const reasonCategoryEnum = pgEnum("reason_category", [
  "SCRAP",
  "REWORK",
  "DOWNTIME",
  "BLOCKED",
]);

export const qualityEventTypeEnum = pgEnum("quality_event_type", ["SCRAP", "REWORK"]);

// ---------------------------------------------------------------------------
// Org / people
// ---------------------------------------------------------------------------
export const stations = pgTable("stations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 200 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("WORKER"),
    stationId: integer("station_id").references(() => stations.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)]
);

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  contactName: varchar("contact_name", { length: 120 }),
  contactEmail: varchar("contact_email", { length: 200 }),
  contactPhone: varchar("contact_phone", { length: 40 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Admin-editable reason codes. Fixed lists (not free text) are what make scrap,
 * rework, downtime and blocking analysable in aggregate.
 */
export const reasonCodes = pgTable(
  "reason_codes",
  {
    id: serial("id").primaryKey(),
    category: reasonCategoryEnum("category").notNull(),
    code: varchar("code", { length: 40 }).notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    active: boolean("active").notNull().default(true),
  },
  (table) => [uniqueIndex("reason_codes_cat_code_idx").on(table.category, table.code)]
);

// ---------------------------------------------------------------------------
// Items / BOM / Routing  (the "customisable process per product" layer)
// ---------------------------------------------------------------------------
export const items = pgTable(
  "items",
  {
    id: serial("id").primaryKey(),
    sku: varchar("sku", { length: 60 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    /** MANUFACTURED items have their own routing and can become sub-assembly work orders. */
    procurementType: procurementTypeEnum("procurement_type").notNull().default("PURCHASED"),
    isFinishedGood: boolean("is_finished_good").notNull().default(false),
    unitOfMeasure: varchar("unit_of_measure", { length: 20 }).notNull().default("ea"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("items_sku_idx").on(table.sku)]
);

/**
 * Routing = the ordered operations to build ONE item. Each item has its own routing,
 * which is what gives "a different process for each product we make".
 */
export const routingSteps = pgTable(
  "routing_steps",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id),
    sequence: integer("sequence").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    stationId: integer("station_id").references(() => stations.id),
    expectedMinutes: integer("expected_minutes"),
    instructions: text("instructions"),
  },
  (table) => [index("routing_steps_item_idx").on(table.itemId, table.sequence)]
);

/**
 * BOM. `consumedAtRoutingStepId` says WHERE in the routing this component is
 * consumed from stock — placing it correctly is what keeps stock numbers believable.
 * Null = consumed when the work order completes.
 */
export const bomLines = pgTable(
  "bom_lines",
  {
    id: serial("id").primaryKey(),
    parentItemId: integer("parent_item_id")
      .notNull()
      .references(() => items.id),
    componentItemId: integer("component_item_id")
      .notNull()
      .references(() => items.id),
    quantity: integer("quantity").notNull().default(1),
    consumedAtRoutingStepId: integer("consumed_at_routing_step_id").references(
      () => routingSteps.id
    ),
  },
  (table) => [index("bom_lines_parent_idx").on(table.parentItemId)]
);

// ---------------------------------------------------------------------------
// Work orders — now HIERARCHICAL (unit -> sub-assemblies -> their own steps)
// ---------------------------------------------------------------------------
export const workOrders = pgTable(
  "work_orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: varchar("order_number", { length: 40 }).notNull(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id),
    customerId: integer("customer_id").references(() => customers.id),
    quantity: integer("quantity").notNull().default(1),
    dueDate: timestamp("due_date"),
    status: workOrderStatusEnum("status").notNull().default("PLANNED"),

    /** Sub-assembly support: a child work order builds one component of its parent. */
    parentWorkOrderId: integer("parent_work_order_id").references(
      (): AnyPgColumn => workOrders.id
    ),
    /** 0 = the top-level unit, 1 = a sub-assembly of it, 2 = sub-sub, ... */
    level: integer("level").notNull().default(0),
    /** Which BOM line of the parent this child was spawned to satisfy. */
    sourceBomLineId: integer("source_bom_line_id").references(() => bomLines.id),

    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("work_orders_order_number_idx").on(table.orderNumber),
    index("work_orders_parent_idx").on(table.parentWorkOrderId),
  ]
);

/**
 * A task is one operation on one work order. It carries its OWN snapshot of
 * name/station/expectedMinutes rather than only pointing at the routing template,
 * so that (a) editing a routing never rewrites history, and (b) a single order can
 * be customised — add, remove or re-time a step for this unit only.
 */
export const workOrderTasks = pgTable(
  "work_order_tasks",
  {
    id: serial("id").primaryKey(),
    workOrderId: integer("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    /** Provenance only — null means this step was added ad-hoc for this order. */
    routingStepId: integer("routing_step_id").references(() => routingSteps.id),

    sequence: integer("sequence").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    stationId: integer("station_id").references(() => stations.id),
    expectedMinutes: integer("expected_minutes"),

    status: taskStatusEnum("status").notNull().default("PENDING"),
    completedByUserId: integer("completed_by_user_id").references(() => users.id),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),

    blockedReasonCodeId: integer("blocked_reason_code_id").references(() => reasonCodes.id),
    blockedNote: text("blocked_note"),
    notes: text("notes"),
  },
  (table) => [
    index("work_order_tasks_wo_idx").on(table.workOrderId, table.sequence),
    index("work_order_tasks_station_idx").on(table.stationId, table.status),
  ]
);

/** Append-only audit log. Every status change, human or machine, lands here. */
export const taskEvents = pgTable(
  "task_events",
  {
    id: serial("id").primaryKey(),
    workOrderTaskId: integer("work_order_task_id")
      .notNull()
      .references(() => workOrderTasks.id),
    type: taskEventTypeEnum("type").notNull(),
    actorUserId: integer("actor_user_id").references(() => users.id),
    source: eventSourceEnum("source").notNull().default("HUMAN"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("task_events_task_idx").on(table.workOrderTaskId)]
);

// ---------------------------------------------------------------------------
// Timesheets — append-only; workers can never edit or delete a recorded entry
// ---------------------------------------------------------------------------
export const timeEntries = pgTable(
  "time_entries",
  {
    id: serial("id").primaryKey(),
    workOrderTaskId: integer("work_order_task_id")
      .notNull()
      .references(() => workOrderTasks.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    /** Written once on clock-out. Never mutated — corrections go in adjustments. */
    durationSeconds: integer("duration_seconds"),
    source: eventSourceEnum("source").notNull().default("HUMAN"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("time_entries_user_idx").on(table.userId, table.startedAt),
    index("time_entries_task_idx").on(table.workOrderTaskId),
  ]
);

/**
 * A correction NEVER overwrites a time entry. It is a new row recording who changed
 * what, from what, to what, and why. Effective duration = latest adjustment, else original.
 */
export const timeEntryAdjustments = pgTable("time_entry_adjustments", {
  id: serial("id").primaryKey(),
  timeEntryId: integer("time_entry_id")
    .notNull()
    .references(() => timeEntries.id),
  adjustedByUserId: integer("adjusted_by_user_id")
    .notNull()
    .references(() => users.id),
  previousDurationSeconds: integer("previous_duration_seconds"),
  newDurationSeconds: integer("new_duration_seconds").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------
export const qualityEvents = pgTable("quality_events", {
  id: serial("id").primaryKey(),
  workOrderTaskId: integer("work_order_task_id")
    .notNull()
    .references(() => workOrderTasks.id),
  type: qualityEventTypeEnum("type").notNull(),
  quantity: integer("quantity").notNull().default(1),
  reasonCodeId: integer("reason_code_id").references(() => reasonCodes.id),
  notes: text("notes"),
  recordedByUserId: integer("recorded_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Inventory
//
// The legacy `inventory_items` / `stock_transactions` tables were REMOVED. They were a
// second, unguarded way to change stock: no command identity, no row locking, no
// sufficiency check. Inventory now lives in inventory_balances (current state) and
// inventory_movements (append-only history), reachable only through src/lib/inventory.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Attachments (drawings / work instructions at the station)
// ---------------------------------------------------------------------------
export const attachments = pgTable("attachments", {
  id: serial("id").primaryKey(),
  workOrderId: integer("work_order_id").references(() => workOrders.id),
  workOrderTaskId: integer("work_order_task_id").references(() => workOrderTasks.id),
  routingStepId: integer("routing_step_id").references(() => routingSteps.id),
  fileName: varchar("file_name", { length: 300 }).notNull(),
  mimeType: varchar("mime_type", { length: 120 }),
  storagePath: text("storage_path").notNull(),
  revision: varchar("revision", { length: 40 }),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// API keys (future vision / sensor integrations post events through this)
// ---------------------------------------------------------------------------
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  label: varchar("label", { length: 120 }).notNull(),
  hashedKey: text("hashed_key").notNull(),
  scope: varchar("scope", { length: 60 }).notNull().default("events:write"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
export const usersRelations = relations(users, ({ one }) => ({
  station: one(stations, { fields: [users.stationId], references: [stations.id] }),
}));

export const itemsRelations = relations(items, ({ many }) => ({
  routingSteps: many(routingSteps),
  bomLines: many(bomLines, { relationName: "parentItem" }),
}));

export const routingStepsRelations = relations(routingSteps, ({ one }) => ({
  item: one(items, { fields: [routingSteps.itemId], references: [items.id] }),
  station: one(stations, { fields: [routingSteps.stationId], references: [stations.id] }),
}));

export const bomLinesRelations = relations(bomLines, ({ one }) => ({
  parentItem: one(items, {
    fields: [bomLines.parentItemId],
    references: [items.id],
    relationName: "parentItem",
  }),
  componentItem: one(items, {
    fields: [bomLines.componentItemId],
    references: [items.id],
  }),
  consumedAtStep: one(routingSteps, {
    fields: [bomLines.consumedAtRoutingStepId],
    references: [routingSteps.id],
  }),
}));

export const workOrdersRelations = relations(workOrders, ({ one, many }) => ({
  item: one(items, { fields: [workOrders.itemId], references: [items.id] }),
  customer: one(customers, { fields: [workOrders.customerId], references: [customers.id] }),
  tasks: many(workOrderTasks),
  parent: one(workOrders, {
    fields: [workOrders.parentWorkOrderId],
    references: [workOrders.id],
    relationName: "parentChild",
  }),
  children: many(workOrders, { relationName: "parentChild" }),
}));

export const workOrderTasksRelations = relations(workOrderTasks, ({ one, many }) => ({
  workOrder: one(workOrders, {
    fields: [workOrderTasks.workOrderId],
    references: [workOrders.id],
  }),
  routingStep: one(routingSteps, {
    fields: [workOrderTasks.routingStepId],
    references: [routingSteps.id],
  }),
  station: one(stations, {
    fields: [workOrderTasks.stationId],
    references: [stations.id],
  }),
  completedBy: one(users, {
    fields: [workOrderTasks.completedByUserId],
    references: [users.id],
  }),
  blockedReason: one(reasonCodes, {
    fields: [workOrderTasks.blockedReasonCodeId],
    references: [reasonCodes.id],
  }),
  events: many(taskEvents),
  timeEntries: many(timeEntries),
  qualityEvents: many(qualityEvents),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(workOrderTasks, {
    fields: [taskEvents.workOrderTaskId],
    references: [workOrderTasks.id],
  }),
  actor: one(users, { fields: [taskEvents.actorUserId], references: [users.id] }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one, many }) => ({
  task: one(workOrderTasks, {
    fields: [timeEntries.workOrderTaskId],
    references: [workOrderTasks.id],
  }),
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
  adjustments: many(timeEntryAdjustments),
}));

export const timeEntryAdjustmentsRelations = relations(timeEntryAdjustments, ({ one }) => ({
  timeEntry: one(timeEntries, {
    fields: [timeEntryAdjustments.timeEntryId],
    references: [timeEntries.id],
  }),
  adjustedBy: one(users, {
    fields: [timeEntryAdjustments.adjustedByUserId],
    references: [users.id],
  }),
}));

export const qualityEventsRelations = relations(qualityEvents, ({ one }) => ({
  task: one(workOrderTasks, {
    fields: [qualityEvents.workOrderTaskId],
    references: [workOrderTasks.id],
  }),
  reasonCode: one(reasonCodes, {
    fields: [qualityEvents.reasonCodeId],
    references: [reasonCodes.id],
  }),
  recordedBy: one(users, {
    fields: [qualityEvents.recordedByUserId],
    references: [users.id],
  }),
}));



// ===========================================================================
// Inventory engine — IMPL-SPEC rev 3
//
// Two distinct objects (spec §5):
//   inventoryMovements  append-only accounting history, never updated
//   inventoryBalances   transactionally maintained summary, locked for updates
// Reconciliation asserts the second equals the sum of the first.
// ===========================================================================

export const movementTypeEnum = pgEnum("movement_type", [
  "RECEIPT",
  "ISSUE",
  "RETURN",
  "TRANSFER",
  "ADJUSTMENT",
  "SCRAP",
  "PRODUCTION_RECEIPT",
  "SHIPMENT",
  "REVERSAL",
]);

export const inventoryLocations = pgTable(
  "inventory_locations",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
  },
  (t) => [uniqueIndex("inventory_locations_code_idx").on(t.code)]
);

/** Summary per item per location. CHECK constraints are added in 0002_constraints.sql. */
export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id").notNull().references(() => items.id),
    locationId: integer("location_id").notNull().references(() => inventoryLocations.id),
    onHand: integer("on_hand").notNull().default(0),
    activeReserved: integer("active_reserved").notNull().default(0),
    /** On quality hold. Not available to reserve or issue, by anyone (spec §1 inv. 6). */
    heldQty: integer("held_qty").notNull().default(0),
  },
  (t) => [uniqueIndex("inventory_balances_item_loc_idx").on(t.itemId, t.locationId)]
);

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => items.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocations.id),
  type: movementTypeEnum("type").notNull(),
  /** Signed: negative leaves the location, positive enters it. */
  quantity: integer("quantity").notNull(),
  requirementId: integer("requirement_id"),
  reservationId: integer("reservation_id"),
  commandId: varchar("command_id", { length: 64 }),
  actorUserId: integer("actor_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Demand, scoped to ONE operation (spec §2) — not to the order, so two operations
 * in the same order cannot both claim the same motors.
 */
export const materialRequirements = pgTable("material_requirements", {
  id: serial("id").primaryKey(),
  operationId: integer("operation_id").notNull().references(() => workOrderTasks.id),
  itemId: integer("item_id").notNull().references(() => items.id),
  requiredQty: integer("required_qty").notNull(),
  issuedQty: integer("issued_qty").notNull().default(0),
  returnedQty: integer("returned_qty").notNull().default(0),
  scrappedFromWipQty: integer("scrapped_from_wip_qty").notNull().default(0),
});

/** Stock earmarked to one requirement. Paired with componentAllocations in one transaction. */
export const reservations = pgTable("reservations", {
  id: serial("id").primaryKey(),
  requirementId: integer("requirement_id").notNull().references(() => materialRequirements.id),
  itemId: integer("item_id").notNull().references(() => items.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocations.id),
  outstandingQty: integer("outstanding_qty").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Database-enforced command replay protection (spec §6). */
export const processedCommands = pgTable("processed_commands", {
  commandId: varchar("command_id", { length: 64 }).primaryKey(),
  commandType: varchar("command_type", { length: 60 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  resultRef: text("result_ref"),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

/** Open/closed quality holds on stock. Append-only; heldQty reconciles against these. */
export const inventoryHolds = pgTable("inventory_holds", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => items.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocations.id),
  quantity: integer("quantity").notNull(),
  reason: text("reason").notNull(),
  releasedAt: timestamp("released_at"),
  raisedByUserId: integer("raised_by_user_id").references(() => users.id),
  releasedByUserId: integer("released_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * CURRENT disposition state for one operation's output (spec §1 Axis B).
 * Mutable on purpose: availability must never be derived from monotonic counters.
 * DispositionRecord below carries the append-only history.
 */
export const operationOutputs = pgTable(
  "operation_outputs",
  {
    id: serial("id").primaryKey(),
    operationId: integer("operation_id").notNull().references(() => workOrderTasks.id),
    produced: integer("produced").notNull().default(0),
    pendingInspection: integer("pending_inspection").notNull().default(0),
    accepted: integer("accepted").notNull().default(0),
    awaitingRework: integer("awaiting_rework").notNull().default(0),
    scrapped: integer("scrapped").notNull().default(0),
    allocatedOutstanding: integer("allocated_outstanding").notNull().default(0),
    /** Net of returns from the parent. */
    issuedToParentOutstanding: integer("issued_to_parent_outstanding").notNull().default(0),
    heldQty: integer("held_qty").notNull().default(0),
  },
  (t) => [uniqueIndex("operation_outputs_operation_idx").on(t.operationId)]
);

export const dispositionKindEnum = pgEnum("disposition_kind", [
  "PRODUCED",
  "ACCEPT",
  "REWORK",
  "SCRAP",
  "ALLOCATE",
  "DEALLOCATE",
  "ISSUE_TO_PARENT",
  "RETURN_FROM_PARENT",
  "HOLD",
  "RELEASE_HOLD",
  "REJECT_INSTALLED",
]);

/** Append-only history of every disposition movement. Never updated. */
export const dispositionRecords = pgTable("disposition_records", {
  id: serial("id").primaryKey(),
  operationId: integer("operation_id").notNull().references(() => workOrderTasks.id),
  kind: dispositionKindEnum("kind").notNull(),
  quantity: integer("quantity").notNull(),
  requirementId: integer("requirement_id").references(() => materialRequirements.id),
  reason: text("reason"),
  commandId: varchar("command_id", { length: 64 }),
  actorUserId: integer("actor_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const inventoryBalancesRelations = relations(inventoryBalances, ({ one }) => ({
  item: one(items, { fields: [inventoryBalances.itemId], references: [items.id] }),
  location: one(inventoryLocations, {
    fields: [inventoryBalances.locationId],
    references: [inventoryLocations.id],
  }),
}));

export const materialRequirementsRelations = relations(materialRequirements, ({ one, many }) => ({
  operation: one(workOrderTasks, {
    fields: [materialRequirements.operationId],
    references: [workOrderTasks.id],
  }),
  item: one(items, { fields: [materialRequirements.itemId], references: [items.id] }),
  reservations: many(reservations),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  requirement: one(materialRequirements, {
    fields: [reservations.requirementId],
    references: [materialRequirements.id],
  }),
  item: one(items, { fields: [reservations.itemId], references: [items.id] }),
}));
```
