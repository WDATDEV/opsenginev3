import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { createDb, ensureSchema, type Database } from "@opsengine/db";
import { sql } from "drizzle-orm";
import { runSeed } from "./seed-on-boot.js";

@Injectable()
export class DbService implements OnModuleInit {
  private readonly log = new Logger("Database");
  readonly db: Database = createDb();

  async onModuleInit() {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    await ensureSchema(url);

    if (process.env.CLEAR_ON_BOOT === "1") {
      this.log.log("Clearing the database.");
      await this.db.execute(sql`
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
          tracking.activity_types,
          tracking.site,
          work.job_assignees,
          work.tasks,
          clients.charges,
          clients.invoices,
          clients.rate_cards,
          work.jobs,
          clients.clients,
          audit.activity,
          identity.users
        RESTART IDENTITY CASCADE
      `);
      this.log.log("Database cleared.");
    }

    if (process.env.SEED_ON_BOOT === "0") return;
    const count = await this.userCount();
    if (process.env.SEED_ON_BOOT !== "1" && count > 0) return;

    this.log.log("Seeding the database.");
    await runSeed();
    this.log.log("Database seed finished.");
  }

  private async userCount() {
    const rows = await this.db.execute<{ n: number }>(sql`select count(*)::int as n from identity.users`);
    const first = rows[0];
    return Number(first?.n ?? 0);
  }
}
