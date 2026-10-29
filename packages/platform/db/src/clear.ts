import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";

config({ path: resolve(process.cwd(), "../../../.env") });
config({ path: resolve(process.cwd(), ".env") });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url);

await sql.unsafe(`
TRUNCATE TABLE
  tracking.sort_scans,
  tracking.load_crew,
  tracking.receipt_lines,
  tracking.shipment_workers,
  tracking.device_checkouts,
  tracking.station_sessions,
  tracking.pack_events,
  tracking.pick_events,
  tracking.activity_segments,
  tracking.breaks,
  tracking.shifts,
  tracking.inbound_loads,
  tracking.inbound_shipments,
  tracking.gaylords,
  tracking.devices,
  tracking.employees,
  work.job_assignees,
  work.tasks,
  clients.charges,
  clients.invoices,
  clients.rate_cards,
  work.jobs,
  clients.clients,
  audit.activity
RESTART IDENTITY CASCADE;

DELETE FROM tracking.activity_types WHERE client_id IS NOT NULL;
UPDATE identity.users SET client_ids = NULL;
`);

console.log("Cleared clients, jobs, people, equipment, and the work already recorded.");
console.log("Logins are still there. Sign in as nora@opsengine.local / OpsEngine!dev and add a client.");
await sql.end();
process.exit(0);
