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
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
/**
 * FORKLIFT is a worker who moves finished goods rather than making them. They see
 * one screen — what is built and waiting to go — and press one button on it.
 */
export const roleEnum = pgEnum("role", ["WORKER", "FORKLIFT", "SUPERVISOR", "ADMIN"]);

/** Make-vs-buy. MANUFACTURED items can spawn their own sub-assembly work order. */
export const procurementTypeEnum = pgEnum("procurement_type", ["MANUFACTURED", "PURCHASED"]);

export const workOrderStatusEnum = pgEnum("work_order_status", [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "DONE",
  // Built and picked up, but not yet confirmed with the customer. DONE means the
  // factory has finished; these two are about where the machine physically is.
  "IN_TRANSIT",
  "SHIPPED",
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
  /** A supervisor handed this step to a named person, or took it back. */
  "ASSIGNED",
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
  /**
   * Which line this station stands on, for plants that run more than one.
   *
   * Free text rather than a table: a line is a label on a station, not a thing
   * with its own behaviour, and the moment it becomes a table somebody has to
   * maintain it. Null means "this plant is one line" and the floor map shows a
   * single strip, which is the common case.
   */
  line: varchar("line", { length: 60 }),
  /** Position on the floor map within its line. Ties break by id. */
  sortOrder: integer("sort_order").notNull().default(0),
  /**
   * The number written on the machine, and the second half of every job number
   * run there. Unique, unlike `sortOrder` — four cells can share a position on
   * the map, but ORD-0001-20 has to mean exactly one of them.
   */
  number: integer("number").notNull().default(0),
  /**
   * How many jobs can run here at once — benches, cells or machines.
   *
   * This is the only capacity the scheduler honours. People are assumed
   * sufficient: one person per job, always someone available. That assumption is
   * wrong in any real plant and is stated on the schedule screen rather than
   * buried here, because a plan that silently assumes infinite labour is a plan
   * that promises dates the floor cannot hit.
   *
   * Machines are also assumed interchangeable. If one cell cannot run a 12-row
   * coil, this number is a lie and capability has to become part of the model.
   */
  capacity: integer("capacity").notNull().default(1),
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
    /**
     * Output of this item is not usable until someone has inspected it.
     *
     * When true, finishing the operation that makes it produces PENDING INSPECTION
     * quantity and nothing else — it is not accepted, not allocated, and the parent
     * stays blocked. Completing a step and accepting its output are two decisions by
     * two people, and collapsing them is how uninspected work reaches final assembly.
     */
    requiresInspection: boolean("requires_inspection").notNull().default(false),
    unitOfMeasure: varchar("unit_of_measure", { length: 20 }).notNull().default("ea"),
    /**
     * Order more once free stock falls to this. 0 means nobody has set one, which
     * is different from 0 being the threshold — an unset item simply never raises
     * a low-stock alert.
     */
    reorderPoint: integer("reorder_point").notNull().default(0),
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
    /**
     * What was ordered, in the customer's words. Free text on purpose: every job is
     * dimensioned differently, and a fixed set of columns would push the one
     * measurement that matters on this order into a notes field nobody reads.
     */
    dimensions: varchar("dimensions", { length: 200 }),
    materialType: varchar("material_type", { length: 120 }),
    /**
     * When the UNIT this belongs to is promised to the customer.
     *
     * A sub-assembly inherits it, which is right for priority — a frame for a job
     * shipping Friday outranks one shipping next month — and wrong as a deadline.
     * The frame is needed at final assembly days before the unit ships, and that
     * date is DERIVED by the scheduler's backward pass, never stored: a copy would
     * be stale the moment anything moved. See `neededBy` in lib/schedule-data.ts.
     */
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
    /** Copied from the routing step at release, so editing the product later cannot
        silently change what a job already on the floor was told to do. */
    instructions: text("instructions"),

    /**
     * What the job is called on the floor: the order number and the station it
     * runs at, e.g. ORD-0001-20.
     *
     * Stored rather than derived, because a step can be moved to another station
     * after work has started and the number on the paper traveler must not change
     * underneath it. Where one order visits a station twice the second gets a
     * suffix, since a number that identifies two things identifies neither.
     */
    jobNumber: varchar("job_number", { length: 60 }),

    status: taskStatusEnum("status").notNull().default("PENDING"),
    completedByUserId: integer("completed_by_user_id").references(() => users.id),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),

    /**
     * Who this step has been given to.
     *
     * A station tells you WHERE the work happens; this tells you WHO is expected to
     * do it. They are different questions and a station alone cannot answer the
     * second one — which is why Epicor's own customers have an open enhancement
     * request asking for exactly this. Null means "whoever at the station picks it
     * up", which stays the normal case; naming someone is the exception a supervisor
     * reaches for when a job is urgent, skilled, or already half-done by one person.
     */
    assignedToUserId: integer("assigned_to_user_id").references(() => users.id),
    assignedByUserId: integer("assigned_by_user_id").references(() => users.id),
    assignedAt: timestamp("assigned_at"),

    blockedReasonCodeId: integer("blocked_reason_code_id").references(() => reasonCodes.id),
    blockedNote: text("blocked_note"),
    notes: text("notes"),
  },
  (table) => [
    index("work_order_tasks_wo_idx").on(table.workOrderId, table.sequence),
    index("work_order_tasks_station_idx").on(table.stationId, table.status),
    // "What is on my plate" is the single most-loaded query on a worker's screen.
    index("work_order_tasks_assignee_idx").on(table.assignedToUserId, table.status),
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
  /**
   * The MATERIAL that was found bad, when it was material rather than the work.
   *
   * Null means the event is about what this step produced. Set means the operator
   * opened a box and the contents were unusable — a different fault, with a
   * different owner, and the reason it is worth telling apart: the lot below names
   * the heat it came from, so "which heats do we keep rejecting" becomes a question
   * with an answer.
   */
  itemId: integer("item_id").references(() => items.id),
  lotId: integer("lot_id").references((): AnyPgColumn => stockLots.id),
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
//
// The bytes live in Postgres. Not because that is where files belong — it is
// not, past a few megabytes — but because the alternative on a hosted demo is a
// local folder that is wiped on every deploy, and a drawing that vanishes when
// the app restarts is worse than no drawing at all. `storagePath` stays for the
// day this moves to an object store; exactly one of the two is ever set.
// ---------------------------------------------------------------------------

/** Postgres `bytea`. Drizzle has no built-in for it. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const attachments = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    workOrderId: integer("work_order_id").references(() => workOrders.id),
    workOrderTaskId: integer("work_order_task_id").references(() => workOrderTasks.id),
    routingStepId: integer("routing_step_id").references(() => routingSteps.id),
    /** What it is, in the engineer's words: "GA drawing", "Coil schedule". */
    title: varchar("title", { length: 200 }),
    fileName: varchar("file_name", { length: 300 }).notNull(),
    mimeType: varchar("mime_type", { length: 120 }),
    content: bytea("content"),
    storagePath: text("storage_path"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    /**
     * The revision the shop is building to.
     *
     * Free text because it comes off the title block, and a drawing office's
     * scheme is theirs. Shown next to the file everywhere, because the failure
     * this guards against is somebody fabricating to rev B while rev C is on
     * the server.
     */
    revision: varchar("revision", { length: 40 }),
    uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("attachments_order_idx").on(t.workOrderId),
    index("attachments_task_idx").on(t.workOrderTaskId),
  ]
);

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
    relationName: "completedBy",
  }),
  assignedTo: one(users, {
    fields: [workOrderTasks.assignedToUserId],
    references: [users.id],
    relationName: "assignedTo",
  }),
  assignedBy: one(users, {
    fields: [workOrderTasks.assignedByUserId],
    references: [users.id],
    relationName: "assignedBy",
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

/** Who material was bought from. Needed before a lot can say where it came from. */
export const vendors = pgTable(
  "vendors",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    contactName: varchar("contact_name", { length: 120 }),
    contactEmail: varchar("contact_email", { length: 200 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("vendors_name_idx").on(t.name)]
);

/**
 * A received batch of one item, with the identity a fabricator is asked about later.
 *
 * The heat number is the one that matters here. Thermal Corp buys galvanized sheet, and
 * a heat number is how a mill certificate is tied to the plate it certifies — a customer
 * asking "what steel is in this unit" is asking for a heat, and a shop that cannot answer
 * has a quality problem it cannot close. Adding this later is not equivalent: every lot
 * received before the column exists is permanently unidentifiable.
 *
 * WHY A LOT IS NOT A BALANCE. Stock levels stay in inventory_balances, keyed by item and
 * location only. A lot's remaining quantity is DERIVED by summing the signed movements
 * that carry its id. That keeps one source of truth: a stored per-lot quantity would be a
 * second number to keep in step with the first, and the pair would eventually disagree
 * with no way to say which was right. The cost is that issuing has to choose a lot; it
 * chooses oldest-first and records the choice, which is what makes the trace possible.
 */
export const stockLots = pgTable(
  "stock_lots",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id),
    /** Mill heat / cast number. Free text — it comes off the supplier's certificate. */
    heatNumber: varchar("heat_number", { length: 60 }),
    /** The shop's own label for this batch, and what goes on the barcode. */
    batchNumber: varchar("batch_number", { length: 60 }),
    vendorId: integer("vendor_id").references(() => vendors.id),
    /** Purchase order or delivery reference this arrived against. */
    procurementReference: varchar("procurement_reference", { length: 80 }),
    /** Where in the building it physically sits — "IN Bay 01", a rack, a pallet position. */
    storageLocation: varchar("storage_location", { length: 120 }),
    /** Oldest-first issue orders on this, not on the row id. */
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    notes: text("notes"),
  },
  (t) => [
    index("stock_lots_item_idx").on(t.itemId, t.receivedAt),
    // Batch numbers are what get scanned, so they have to resolve to exactly one lot.
    uniqueIndex("stock_lots_batch_idx").on(t.batchNumber),
  ]
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
  /**
   * Which received batch this movement was of. Nullable, and deliberately so: stock
   * that predates lot tracking, and adjustments that are not about a particular batch,
   * genuinely have no lot. A null here means "not known", never "no lot" — code that
   * traces must say so rather than quietly dropping those rows.
   */
  lotId: integer("lot_id").references(() => stockLots.id),
  /**
   * True when NOBODY named this lot — the system inferred it, oldest-first.
   *
   * This column exists because the alternative is a lie. Picking the oldest lot is a
   * sensible default and a poor fact: if the handler walked past it and took the
   * pallet in front, an inferred lot recorded as confirmed produces a trace that is
   * indistinguishable from a real one and wrong. A trace that can answer "which of
   * these do you actually know" is worth having; one that cannot is worse than none,
   * because it will be believed.
   */
  lotAssumed: boolean("lot_assumed").notNull().default(false),
  /**
   * Why, in the handler's words. Required for a write-off.
   *
   * A scrap with no reason is a quantity that vanished, and three months later
   * nobody can say whether it was a forklift, a bad heat or a miscount. The
   * reason is the difference between a stock record and an explanation.
   */
  note: text("note"),
  commandId: varchar("command_id", { length: 64 }),
  actorUserId: integer("actor_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [index("inventory_movements_lot_idx").on(t.lotId)]);

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

export const stockLotsRelations = relations(stockLots, ({ one, many }) => ({
  item: one(items, { fields: [stockLots.itemId], references: [items.id] }),
  vendor: one(vendors, { fields: [stockLots.vendorId], references: [vendors.id] }),
  movements: many(inventoryMovements),
}));

export const inventoryMovementsRelations = relations(inventoryMovements, ({ one }) => ({
  item: one(items, { fields: [inventoryMovements.itemId], references: [items.id] }),
  location: one(inventoryLocations, {
    fields: [inventoryMovements.locationId],
    references: [inventoryLocations.id],
  }),
  lot: one(stockLots, { fields: [inventoryMovements.lotId], references: [stockLots.id] }),
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

// ===========================================================================
// Operation dependencies — IMPL-SPEC §2
//
// A sequence number is display order only. Whether a step may start is decided
// by explicit dependency records, which is what makes convergent assembly work:
// final assembly can wait on a SUB-ASSEMBLY's output, not merely on the step
// numbered before it in its own routing.
//
// SPECIFIC_UNIT from the spec is deliberately absent. It requires lot/serial
// identity, which this system does not yet track, and a dependency type that can
// never be satisfied is worse than one that does not exist.
// ===========================================================================

/**
 * A delivery note's life. Forward only — see `advanceDeliveryNote`.
 *
 * UNASSIGNED is the raised-but-nobody-is-carrying-it state, which exists because
 * on a real floor the note is written before the driver is known.
 */
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "UNASSIGNED",
  "ALLOCATED",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
]);

export const dependencyTypeEnum = pgEnum("dependency_type", [
  /** The predecessor operation is DONE. */
  "FULL_COMPLETION",
  /** Enough of a component has been allocated to, or installed against, one requirement. */
  "REQUIRED_QUANTITY",
  /** The source operation's output carries no open quality hold. */
  "QUALITY_ACCEPTANCE",
]);

export const operationDependencies = pgTable(
  "operation_dependencies",
  {
    id: serial("id").primaryKey(),
    /** The operation that waits. */
    operationId: integer("operation_id")
      .notNull()
      .references((): AnyPgColumn => workOrderTasks.id),
    /** What it waits on. Null when the dependency is on material alone. */
    dependsOnOperationId: integer("depends_on_operation_id").references(
      (): AnyPgColumn => workOrderTasks.id
    ),
    type: dependencyTypeEnum("type").notNull(),
    /** Scoped to a requirement, never to an order — two operations in one order
     *  must not both claim the same motors. */
    requirementId: integer("requirement_id").references(
      (): AnyPgColumn => materialRequirements.id
    ),
    requiredQuantity: integer("required_quantity"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("operation_dependencies_op_idx").on(t.operationId),
    index("operation_dependencies_src_idx").on(t.dependsOnOperationId),
  ]
);

export const operationDependenciesRelations = relations(operationDependencies, ({ one }) => ({
  operation: one(workOrderTasks, {
    fields: [operationDependencies.operationId],
    references: [workOrderTasks.id],
  }),
  dependsOn: one(workOrderTasks, {
    fields: [operationDependencies.dependsOnOperationId],
    references: [workOrderTasks.id],
  }),
  requirement: one(materialRequirements, {
    fields: [operationDependencies.requirementId],
    references: [materialRequirements.id],
  }),
}));

// ===========================================================================
// Alerts
//
// Two kinds of thing get called an alert, and they behave differently enough
// that only one of them belongs in a table:
//
//   A TRANSITION happened at a moment — a step was blocked, or something a
//   station was waiting on arrived. Nobody can recompute it later from current
//   state, and somebody has to be able to say they have dealt with it. Those
//   are rows here, written in the same transaction as the action that caused
//   them.
//
//   A CONDITION is simply true right now — material is short, a step has run
//   past its estimate. Storing those creates alerts that outlive the problem.
//   They are derived at read time in src/lib/alerts.ts and never stored.
// ===========================================================================

export const alertKindEnum = pgEnum("alert_kind", [
  /** A worker could not continue. Goes to whoever supervises. */
  "STEP_BLOCKED",
  /** What a station was waiting on has arrived. Goes to that station. */
  "STEP_READY",
  /** A supervisor put this step on one person's plate. Goes to that person. */
  "ASSIGNED_TO_YOU",
]);

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    kind: alertKindEnum("kind").notNull(),
    workOrderTaskId: integer("work_order_task_id").references(() => workOrderTasks.id),
    workOrderId: integer("work_order_id").references(() => workOrders.id),
    /**
     * Who needs to know. A station means the people working there; null means
     * supervisors and admins, who see everything anyway.
     */
    audienceStationId: integer("audience_station_id").references(() => stations.id),
    /**
     * Narrower than a station: one named person. Set when the alert is about
     * something only they can act on — work handed to them by name. An alert with
     * an audience user is NOT also shown to the station, or being given a job would
     * notify everyone standing near you.
     */
    audienceUserId: integer("audience_user_id").references(() => users.id),
    title: varchar("title", { length: 200 }).notNull(),
    detail: text("detail"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedByUserId: integer("acknowledged_by_user_id").references(() => users.id),
  },
  (t) => [
    index("alerts_open_idx").on(t.acknowledgedAt, t.createdAt),
    index("alerts_audience_idx").on(t.audienceStationId),
  ]
);

export const alertsRelations = relations(alerts, ({ one }) => ({
  task: one(workOrderTasks, {
    fields: [alerts.workOrderTaskId],
    references: [workOrderTasks.id],
  }),
  workOrder: one(workOrders, { fields: [alerts.workOrderId], references: [workOrders.id] }),
  audienceStation: one(stations, {
    fields: [alerts.audienceStationId],
    references: [stations.id],
  }),
  audienceUser: one(users, {
    fields: [alerts.audienceUserId],
    references: [users.id],
  }),
}));

/**
 * Dispatch — the record that finished goods left the building.
 *
 * The app could previously follow a unit from raw stock to "done" and then lost
 * it: `receiveDelivery` books material in, and nothing booked anything out. A
 * delivery note closes that, and is the thing a customer asks about by number.
 */
export const deliveryNotes = pgTable(
  "delivery_notes",
  {
    id: serial("id").primaryKey(),
    noteNumber: varchar("note_number", { length: 40 }).notNull(),
    workOrderId: integer("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    quantity: integer("quantity").notNull(),
    status: deliveryStatusEnum("status").notNull().default("UNASSIGNED"),
    /** Who is carrying it. Null until someone is named. */
    handlerUserId: integer("handler_user_id").references(() => users.id),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    pickedUpAt: timestamp("picked_up_at"),
    deliveredAt: timestamp("delivered_at"),
  },
  (t) => [
    uniqueIndex("delivery_notes_number_idx").on(t.noteNumber),
    index("delivery_notes_order_idx").on(t.workOrderId, t.status),
  ]
);

export const deliveryNotesRelations = relations(deliveryNotes, ({ one }) => ({
  workOrder: one(workOrders, {
    fields: [deliveryNotes.workOrderId],
    references: [workOrders.id],
  }),
  handler: one(users, { fields: [deliveryNotes.handlerUserId], references: [users.id] }),
}));
