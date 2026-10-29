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
  created_at timestamptz NOT NULL DEFAULT now()
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
  created_at timestamptz NOT NULL DEFAULT now()
);

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
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

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
  created_at timestamptz NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS tracking.activity_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  shift_id uuid NOT NULL REFERENCES tracking.shifts(id),
  department text NOT NULL,
  task_code text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  device_id uuid,
  note text
);

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
  employee_id uuid NOT NULL REFERENCES tracking.employees(id),
  device_id uuid NOT NULL REFERENCES tracking.devices(id),
  via text NOT NULL,
  picked_at timestamptz NOT NULL,
  segment_id uuid
);

CREATE TABLE IF NOT EXISTS tracking.inbound_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  client_id uuid NOT NULL,
  carrier text NOT NULL,
  status text NOT NULL DEFAULT 'expected',
  expected_cartons integer NOT NULL DEFAULT 0,
  received_cartons integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

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
  recorded_at timestamptz NOT NULL
);

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
  carton_count integer
);

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
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

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
