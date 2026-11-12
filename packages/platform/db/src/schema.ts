import { sql } from "drizzle-orm";
import {
  bigint,
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
import { encryptedText } from "./secret-box.js";

export const identity = pgSchema("identity");
export const clients = pgSchema("clients");
export const work = pgSchema("work");
export const audit = pgSchema("audit");
export const tracking = pgSchema("tracking");
export const mail = pgSchema("mail");

export const connectors = mail.table("connectors", {
  kind: text("kind").primaryKey(),
  label: text("label"),
  // Encrypted at rest. See secret-box.ts.
  secret: encryptedText("secret"),
  extra: text("extra"),
  detail: text("detail"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const letters = mail.table("letters", {
  id: uuid("id").defaultRandom().primaryKey(),
  gmailId: text("gmail_id").notNull().unique(),
  threadId: text("thread_id").notNull(),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  clientId: uuid("client_id"),
  status: text("status").notNull().default("new"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type RuleCondition = {
  field: "subject" | "body" | "sender" | "domain";
  op: "contains_any" | "contains_all" | "not_contains" | "equals" | "ends_with";
  value: string;
};

export type RuleDraft = {
  enabled: boolean;
  instructions: string;
  // Fixed business facts Claude may quote, such as opening hours. Rules saved before this field exist lack it.
  facts?: string;
  model: "haiku" | "sonnet";
  useWarehance: boolean;
  warehanceClientId: number | null;
  spreadsheet: boolean;
};

export type RuleSlack = {
  enabled: boolean;
  channel: string;
  mentions: string[];
  direct: string[];
  includeDraft: boolean;
};

export const rules = mail.table("rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  matchMode: text("match_mode").notNull().default("all"),
  conditions: jsonb("conditions").$type<RuleCondition[]>().notNull().default([]),
  draft: jsonb("draft").$type<RuleDraft>().notNull(),
  slack: jsonb("slack").$type<RuleSlack>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runs = mail.table("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  letterId: uuid("letter_id").notNull(),
  ruleId: uuid("rule_id").notNull(),
  status: text("status").notNull().default("working"),
  draftSubject: text("draft_subject"),
  draftBody: text("draft_body"),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewReason: text("review_reason"),
  attachmentName: text("attachment_name"),
  attachmentCsv: text("attachment_csv"),
  lookups: jsonb("lookups").$type<{ tool: string; summary: string }[]>().notNull().default([]),
  slackNote: text("slack_note"),
  error: text("error"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // Set when a person sends the reply from the app. A draft is sent at most once.
  sentAt: timestamp("sent_at", { withTimezone: true }),
  sentTo: text("sent_to"),
});

// ---- Bulk email: contacts, campaigns, and how they are sent ----

export const mailContacts = mail.table("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  clientId: uuid("client_id"),
  // Free labels such as "Customers" or "Staff". A campaign can pick whole groups.
  groups: jsonb("groups").$type<string[]>().notNull().default([]),
  doNotEmail: boolean("do_not_email").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BroadcastAudience = {
  everyone: boolean;
  groups: string[];
  clientIds: string[];
  contactIds: string[];
};

export const broadcasts = mail.table("broadcasts", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull().default("notice"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  audience: jsonb("audience").$type<BroadcastAudience>().notNull(),
  // draft | scheduled | sending | sent | failed
  status: text("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per person, written the moment a campaign starts. It is the record of who was emailed.
export const broadcastRecipients = mail.table("broadcast_recipients", {
  id: uuid("id").defaultRandom().primaryKey(),
  broadcastId: uuid("broadcast_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  clientName: text("client_name").notNull().default(""),
  // pending | sent | failed
  status: text("status").notNull().default("pending"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const broadcastTemplates = mail.table("broadcast_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default("notice"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const broadcastSettings = mail.table("broadcast_settings", {
  id: integer("id").primaryKey().default(1),
  senderName: text("sender_name").notNull().default(""),
  replyTo: text("reply_to").notNull().default(""),
  signature: text("signature").notNull().default(""),
  dailyLimit: integer("daily_limit").notNull().default(400),
  perMinute: integer("per_minute").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---- Chat with the Warehance bot ----

export type ChatLookup = { tool: string; summary: string };

export type ChatSend = {
  kind: "email" | "slack";
  to: string;
  at: string;
  ok: boolean;
  note: string;
  file: string | null;
};

// A send that Claude prepared from what was asked. Nothing goes out until a person presses Send.
export type ChatProposal = {
  kind: "email" | "slack";
  to: string;
  subject: string;
  body: string;
  fileId: string | null;
  fileName: string | null;
};

export type ChatStockRow = {
  sku: string;
  location: string;
  warehouse: string;
  qtyBefore: number;
  qtyAfter: number;
  lotCode: string;
  ok: boolean | null;
  error: string | null;
};

// A Warehance stock change Claude prepared. Nothing is written until the owner confirms.
export type ChatStockChange = {
  logId: string | null;
  clientName: string;
  clientId: number | null;
  warehouse: string;
  action: "set";
  quantity: number;
  reason: string;
  skuPrefix: string;
  rows: ChatStockRow[];
  status: "proposed" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  note: string | null;
};

export const chatThreads = mail.table("chat_threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  title: text("title").notNull().default("New chat"),
  // A Warehance client ID locks every lookup to that client. Empty means all clients.
  warehanceClientId: bigint("warehance_client_id", { mode: "number" }),
  warehanceClientName: text("warehance_client_name"),
  model: text("model").notNull().default("haiku"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatMessages = mail.table("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull().default(""),
  // working | done | failed. Only answers from Claude are ever "working".
  status: text("status").notNull().default("done"),
  error: text("error"),
  lookups: jsonb("lookups").$type<ChatLookup[]>().notNull().default([]),
  proposal: jsonb("proposal").$type<ChatProposal | null>(),
  stockChange: jsonb("stock_change").$type<ChatStockChange | null>(),
  sends: jsonb("sends").$type<ChatSend[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// One Warehance bot page, kept so a failed Chat turn can still be rebuilt into a file.
export const chatStockLogs = mail.table("chat_stock_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").notNull(),
  messageId: uuid("message_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  actorEmail: text("actor_email").notNull().default(""),
  actorName: text("actor_name").notNull().default(""),
  status: text("status").notNull(),
  clientName: text("client_name").notNull().default(""),
  clientId: bigint("client_id", { mode: "number" }),
  warehouse: text("warehouse").notNull().default(""),
  action: text("action").notNull().default("set"),
  quantity: integer("quantity").notNull().default(0),
  reason: text("reason").notNull().default(""),
  skuPrefix: text("sku_prefix").notNull().default(""),
  rows: jsonb("rows").$type<ChatStockRow[]>().notNull().default([]),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatLookupLogs = mail.table("chat_lookup_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").notNull(),
  messageId: uuid("message_id").notNull(),
  tool: text("tool").notNull(),
  args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
  ok: boolean("ok").notNull().default(true),
  error: text("error"),
  recordCount: integer("record_count").notNull().default(0),
  records: jsonb("records").$type<Record<string, unknown>[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatFiles = mail.table("chat_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").notNull(),
  messageId: uuid("message_id").notNull(),
  name: text("name").notNull(),
  format: text("format").notNull(),
  mime: text("mime").notNull(),
  rows: integer("rows").notNull().default(0),
  columns: jsonb("columns").$type<string[]>().notNull().default([]),
  size: integer("size").notNull().default(0),
  // The file itself, base64.
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = identity.table("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  clientIds: jsonb("client_ids").$type<string[] | null>(),
  // Null means use the defaults for that role. An owner can set an explicit list.
  sections: jsonb("sections").$type<string[] | null>(),
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
  // Set on the hourly price of a whole service (packing, picking, ...). Then activityCode is empty.
  department: text("department"),
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
  departments: jsonb("departments").$type<string[] | null>(),
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

// How people prove they are on site: "location" (device must be at the warehouse) or "qr_gate" (checked in at the gate).
export const gateConfig = tracking.table("gate_config", {
  id: integer("id").primaryKey().default(1),
  mode: text("mode").notNull().default("location"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Named spots a QR gate can sit at, such as "Front gate" or "Dock".
export const gatePlaces = tracking.table("gate_places", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
