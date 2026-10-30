import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const identity = pgSchema("identity");
export const clients = pgSchema("clients");
export const work = pgSchema("work");
export const audit = pgSchema("audit");
export const tracking = pgSchema("tracking");

export const users = identity.table("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  clientIds: jsonb("client_ids").$type<string[] | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const clientRecords = clients.table("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  enabledServices: jsonb("enabled_services").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const rateCards = clients.table("rate_cards", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull(),
  activityCode: text("activity_code"),
  unit: text("unit").notNull(),
  rateCents: integer("rate_cents").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const charges = clients.table("charges", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull(),
  jobId: uuid("job_id").notNull(),
  rateCardId: uuid("rate_card_id"),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unit: text("unit").notNull(),
  rateCents: integer("rate_cents").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("draft"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  invoiceId: uuid("invoice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const invoices = clients.table("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull(),
  number: text("number").notNull().unique(),
  status: text("status").notNull().default("open"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const jobs = work.table("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull(),
  reference: text("reference").notNull().unique(),
  title: text("title").notNull(),
  status: text("status").notNull().default("open"),
  billBasis: text("bill_basis").notNull().default("mixed"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobAssignees = work.table("job_assignees", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }),
  activityCode: text("activity_code"),
  autoStartedAt: timestamp("auto_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tasks = work.table("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  details: text("details"),
  status: text("status").notNull().default("open"),
  clientId: uuid("client_id"),
  requestorId: uuid("requestor_id"),
  relatedType: text("related_type"),
  relatedId: uuid("related_id"),
  jobId: uuid("job_id"),
  assigneeId: uuid("assignee_id"),
  dueOn: date("due_on"),
  dependsOnId: uuid("depends_on_id"),
  startAt: timestamp("start_at", { withTimezone: true }),
  activityCode: text("activity_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const activity = audit.table("activity", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  module: text("module").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export const employees = tracking.table("employees", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id"),
  name: text("name").notNull(),
  badgeCode: text("badge_code").notNull().unique(),
  departmentHome: text("department_home").notNull(),
  employmentType: text("employment_type").notNull().default("employee"),
  warehanceUserId: text("warehance_user_id").unique(),
  clientId: uuid("client_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const devices = tracking.table("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  ownership: text("ownership").notNull(),
  assignedEmployeeId: uuid("assigned_employee_id"),
  location: text("location").notNull(),
  status: text("status").notNull().default("available"),
  warehanceLoginMode: text("warehance_login_mode").notNull().default("none"),
  clientId: uuid("client_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const shifts = tracking.table("shifts", {
  id: uuid("id").defaultRandom().primaryKey(),
  employeeId: uuid("employee_id").notNull(),
  clockIn: timestamp("clock_in", { withTimezone: true }).notNull(),
  clockOut: timestamp("clock_out", { withTimezone: true }),
  source: text("source").notNull().default("kiosk"),
  clockInPlace: text("clock_in_place"),
  clockInLat: doublePrecision("clock_in_lat"),
  clockInLng: doublePrecision("clock_in_lng"),
  clockInAccuracy: doublePrecision("clock_in_accuracy"),
  clockOutPlace: text("clock_out_place"),
  clockOutLat: doublePrecision("clock_out_lat"),
  clockOutLng: doublePrecision("clock_out_lng"),
  clockOutAccuracy: doublePrecision("clock_out_accuracy"),
});

export const site = tracking.table("site", {
  id: uuid("id").defaultRandom().primaryKey(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  radiusMeters: integer("radius_meters").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const breaks = tracking.table("breaks", {
  id: uuid("id").defaultRandom().primaryKey(),
  shiftId: uuid("shift_id").notNull(),
  kind: text("kind").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const activityTypes = tracking.table("activity_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  department: text("department").notNull(),
  billable: boolean("billable").notNull().default(true),
  active: boolean("active").notNull().default(true),
  clientId: uuid("client_id"),
});

export const segments = tracking.table("activity_segments", {
  id: uuid("id").defaultRandom().primaryKey(),
  employeeId: uuid("employee_id").notNull(),
  shiftId: uuid("shift_id").notNull(),
  department: text("department").notNull(),
  taskCode: text("task_code").notNull(),
  jobId: uuid("job_id"),
  activityId: uuid("activity_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  deviceId: uuid("device_id"),
  note: text("note"),
});

export const stationSessions = tracking.table("station_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const deviceCheckouts = tracking.table("device_checkouts", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const packEvents = tracking.table("pack_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  clientId: uuid("client_id"),
  employeeId: uuid("employee_id").notNull(),
  deviceId: uuid("device_id").notNull(),
  attribution: text("attribution").notNull(),
  warehanceUserId: text("warehance_user_id"),
  warehanceRecorded: boolean("warehance_recorded").notNull().default(false),
  loginMismatch: boolean("login_mismatch").notNull().default(false),
  units: integer("units").notNull().default(1),
  packedAt: timestamp("packed_at", { withTimezone: true }).notNull(),
  segmentId: uuid("segment_id"),
});

export const pickEvents = tracking.table("pick_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchCode: text("batch_code").notNull(),
  orderNumber: text("order_number"),
  sku: text("sku").notNull(),
  qty: integer("qty").notNull(),
  clientId: uuid("client_id"),
  employeeId: uuid("employee_id").notNull(),
  deviceId: uuid("device_id").notNull(),
  via: text("via").notNull(),
  pickedAt: timestamp("picked_at", { withTimezone: true }).notNull(),
  segmentId: uuid("segment_id"),
});

export const shipments = tracking.table("inbound_shipments", {
  id: uuid("id").defaultRandom().primaryKey(),
  reference: text("reference").notNull().unique(),
  clientId: uuid("client_id").notNull(),
  carrier: text("carrier").notNull(),
  status: text("status").notNull().default("expected"),
  expectedCartons: integer("expected_cartons").notNull().default(0),
  receivedCartons: integer("received_cartons").notNull().default(0),
  jobId: uuid("job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const shipmentWorkers = tracking.table("shipment_workers", {
  id: uuid("id").defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  role: text("role").notNull().default("counter"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }),
});

export const receiptLines = tracking.table("receipt_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  sku: text("sku").notNull(),
  expectedQty: integer("expected_qty").notNull(),
  receivedQty: integer("received_qty").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  segmentId: uuid("segment_id"),
});

export const loads = tracking.table("inbound_loads", {
  id: uuid("id").defaultRandom().primaryKey(),
  reference: text("reference").notNull().unique(),
  kind: text("kind").notNull(),
  dock: text("dock").notNull(),
  status: text("status").notNull().default("arrived"),
  arrivalAt: timestamp("arrival_at", { withTimezone: true }).defaultNow().notNull(),
  unloadStartedAt: timestamp("unload_started_at", { withTimezone: true }),
  unloadEndedAt: timestamp("unload_ended_at", { withTimezone: true }),
  seal: text("seal"),
  palletCount: integer("pallet_count"),
  cartonCount: integer("carton_count"),
  jobId: uuid("job_id"),
  clientId: uuid("client_id"),
});

export const loadCrew = tracking.table("load_crew", {
  id: uuid("id").defaultRandom().primaryKey(),
  loadId: uuid("load_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const gaylords = tracking.table("gaylords", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  carrier: text("carrier").notNull(),
  clientId: uuid("client_id"),
  status: text("status").notNull().default("open"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const sortScans = tracking.table("sort_scans", {
  id: uuid("id").defaultRandom().primaryKey(),
  gaylordId: uuid("gaylord_id").notNull(),
  trackingNumber: text("tracking_number").notNull().unique(),
  employeeId: uuid("employee_id").notNull(),
  deviceId: uuid("device_id"),
  method: text("method").notNull(),
  reason: text("reason"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
});
