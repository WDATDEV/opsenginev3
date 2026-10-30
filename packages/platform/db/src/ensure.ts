import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";

config({ path: resolve(process.cwd(), "../../../.env") });
config({ path: resolve(process.cwd(), ".env") });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url);

await sql.unsafe(`
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS clients;
CREATE SCHEMA IF NOT EXISTS work;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS tracking;

CREATE TABLE IF NOT EXISTS identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  client_ids jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  enabled_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE clients.clients ADD COLUMN IF NOT EXISTS enabled_services jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS work.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients.clients(id),
  reference text NOT NULL UNIQUE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work.jobs ADD COLUMN IF NOT EXISTS bill_basis text NOT NULL DEFAULT 'mixed';

CREATE TABLE IF NOT EXISTS clients.rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients.clients(id),
  activity_code text,
  unit text NOT NULL,
  rate_cents integer NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rate_cards_client_activity_unit
  ON clients.rate_cards (client_id, activity_code, unit);

CREATE TABLE IF NOT EXISTS clients.charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients.clients(id),
  job_id uuid NOT NULL REFERENCES work.jobs(id),
  rate_card_id uuid,
  description text NOT NULL,
  quantity integer NOT NULL,
  unit text NOT NULL,
  rate_cents integer NOT NULL,
  amount_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  idempotency_key text NOT NULL UNIQUE,
  source_type text NOT NULL,
  source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE clients.charges ADD COLUMN IF NOT EXISTS invoice_id uuid;

CREATE TABLE IF NOT EXISTS clients.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients.clients(id),
  number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'open',
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE TABLE IF NOT EXISTS work.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open',
  client_id uuid,
  requestor_id uuid,
  related_type text,
  related_id uuid,
  job_id uuid,
  assignee_id uuid,
  due_on date,
  depends_on_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS assignee_id uuid;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS due_on date;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS depends_on_id uuid;

CREATE TABLE IF NOT EXISTS audit.activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  module text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracking.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  name text NOT NULL,
  badge_code text NOT NULL UNIQUE,
  department_home text NOT NULL,
  employment_type text NOT NULL DEFAULT 'employee',
  warehance_user_id text UNIQUE,
  client_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tracking.employees ADD COLUMN IF NOT EXISTS client_id uuid;

CREATE TABLE IF NOT EXISTS work.job_assignees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES work.jobs(id),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work.job_assignees ADD COLUMN IF NOT EXISTS start_at timestamptz;
ALTER TABLE work.job_assignees ADD COLUMN IF NOT EXISTS activity_code text;
ALTER TABLE work.job_assignees ADD COLUMN IF NOT EXISTS auto_started_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS job_assignees_one_person
  ON work.job_assignees (job_id, employee_id);

CREATE TABLE IF NOT EXISTS tracking.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL,
  label text NOT NULL,
  ownership text NOT NULL,
  assigned_employee_id uuid REFERENCES tracking.employees(id),
  location text NOT NULL,
  status text NOT NULL DEFAULT 'available',
  warehance_login_mode text NOT NULL DEFAULT 'none',
  client_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tracking.devices ADD COLUMN IF NOT EXISTS client_id uuid;

CREATE TABLE IF NOT EXISTS tracking.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  source text NOT NULL DEFAULT 'kiosk'
);

ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_in_place text;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_in_lat double precision;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_in_lng double precision;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_out_place text;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_out_lat double precision;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_out_lng double precision;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_in_accuracy double precision;
ALTER TABLE tracking.shifts ADD COLUMN IF NOT EXISTS clock_out_accuracy double precision;

CREATE TABLE IF NOT EXISTS tracking.site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  radius_meters integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open
  ON tracking.shifts (employee_id) WHERE clock_out IS NULL;

CREATE TABLE IF NOT EXISTS tracking.breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES tracking.shifts(id),
  kind text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS breaks_one_open
  ON tracking.breaks (shift_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tracking.activity_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  department text NOT NULL,
  billable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  client_id uuid
);

ALTER TABLE tracking.activity_types ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE tracking.activity_types DROP CONSTRAINT IF EXISTS activity_types_code_key;
ALTER TABLE tracking.activity_types DROP CONSTRAINT IF EXISTS activity_types_code_unique;
CREATE UNIQUE INDEX IF NOT EXISTS activity_types_code_per_client
  ON tracking.activity_types (code, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS tracking.activity_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  shift_id uuid NOT NULL REFERENCES tracking.shifts(id),
  department text NOT NULL,
  task_code text NOT NULL,
  job_id uuid,
  activity_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text,
  device_id uuid,
  note text
);

ALTER TABLE tracking.activity_segments ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE tracking.activity_segments ADD COLUMN IF NOT EXISTS activity_id uuid;
ALTER TABLE tracking.activity_segments ADD COLUMN IF NOT EXISTS end_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS segments_one_open
  ON tracking.activity_segments (employee_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tracking.station_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES tracking.devices(id),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS station_one_open_device
  ON tracking.station_sessions (device_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tracking.device_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES tracking.devices(id),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS checkout_one_open_device
  ON tracking.device_checkouts (device_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tracking.pack_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  client_id uuid,
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  device_id uuid NOT NULL REFERENCES tracking.devices(id),
  attribution text NOT NULL,
  warehance_user_id text,
  warehance_recorded boolean NOT NULL DEFAULT false,
  login_mismatch boolean NOT NULL DEFAULT false,
  units integer NOT NULL DEFAULT 1,
  packed_at timestamptz NOT NULL,
  segment_id uuid
);

CREATE TABLE IF NOT EXISTS tracking.pick_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code text NOT NULL,
  order_number text,
  sku text NOT NULL,
  qty integer NOT NULL,
  client_id uuid,
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  device_id uuid NOT NULL REFERENCES tracking.devices(id),
  via text NOT NULL,
  picked_at timestamptz NOT NULL,
  segment_id uuid
);

ALTER TABLE tracking.pick_events ADD COLUMN IF NOT EXISTS client_id uuid;

CREATE TABLE IF NOT EXISTS tracking.inbound_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  client_id uuid NOT NULL,
  carrier text NOT NULL,
  status text NOT NULL DEFAULT 'expected',
  expected_cartons integer NOT NULL DEFAULT 0,
  received_cartons integer NOT NULL DEFAULT 0,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tracking.inbound_shipments ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES work.jobs(id);

CREATE TABLE IF NOT EXISTS tracking.shipment_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES tracking.inbound_shipments(id),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  role text NOT NULL DEFAULT 'counter',
  joined_at timestamptz NOT NULL,
  left_at timestamptz
);

CREATE TABLE IF NOT EXISTS tracking.receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES tracking.inbound_shipments(id),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  sku text NOT NULL,
  expected_qty integer NOT NULL,
  received_qty integer NOT NULL,
  recorded_at timestamptz NOT NULL,
  segment_id uuid
);

ALTER TABLE tracking.receipt_lines ADD COLUMN IF NOT EXISTS segment_id uuid;

CREATE TABLE IF NOT EXISTS tracking.inbound_loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  kind text NOT NULL,
  dock text NOT NULL,
  status text NOT NULL DEFAULT 'arrived',
  arrival_at timestamptz NOT NULL DEFAULT now(),
  unload_started_at timestamptz,
  unload_ended_at timestamptz,
  seal text,
  pallet_count integer,
  carton_count integer,
  job_id uuid,
  client_id uuid
);

ALTER TABLE tracking.inbound_loads ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES work.jobs(id);
ALTER TABLE tracking.inbound_loads ADD COLUMN IF NOT EXISTS client_id uuid;

CREATE TABLE IF NOT EXISTS tracking.load_crew (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES tracking.inbound_loads(id),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  source text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS tracking.gaylords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  carrier text NOT NULL,
  client_id uuid,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

ALTER TABLE tracking.gaylords ADD COLUMN IF NOT EXISTS client_id uuid;

CREATE TABLE IF NOT EXISTS tracking.sort_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gaylord_id uuid NOT NULL REFERENCES tracking.gaylords(id),
  tracking_number text NOT NULL UNIQUE,
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  device_id uuid,
  method text NOT NULL,
  reason text,
  scanned_at timestamptz NOT NULL
);
`);

await sql.end();
console.log("Tracking schema is ready.");
