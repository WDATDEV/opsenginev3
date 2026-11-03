import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { activityTypes, createDb, ensureSchema, seal, type Database } from "@opsengine/db";
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

    await this.encryptLegacySecrets();
    await this.ensureActivityTypes();

    const count = await this.userCount();
    if (process.env.SEED_ON_BOOT !== "1" && count > 0) return;

    this.log.log("Seeding the database.");
    await runSeed();
    this.log.log("Database seed finished.");
  }

  /** Jobs and the floor phone depend on these work types. Add any that are missing; never change ones that exist. */
  private async ensureActivityTypes() {
    const standard = [
      ["pack_orders", "Pack orders", "packing", true],
      ["pick_batch", "Pick batch", "picking", true],
      ["receive_shipment", "Count and receive", "receiving", true],
      ["inspect", "Inspect", "receiving", true],
      ["putaway", "Putaway", "receiving", true],
      ["unload_trailer", "Unload trailer", "unloading", true],
      ["sort_gaylord", "Sort to carrier", "sorting", true],
      ["kitting", "Kitting", "packing", true],
      ["labeling", "Labeling", "packing", true],
      ["returns", "Returns", "receiving", true],
      ["indirect", "Internal work", "indirect", false],
    ] as const;
    const rows = await this.db.select({ code: activityTypes.code, clientId: activityTypes.clientId }).from(activityTypes);
    const have = new Set(rows.filter((row) => row.clientId == null).map((row) => row.code));
    const missing = standard.filter(([code]) => !have.has(code));
    if (missing.length === 0) return;
    await this.db
      .insert(activityTypes)
      .values(missing.map(([code, name, department, billable]) => ({ code, name, department, billable })))
      .onConflictDoNothing();
    this.log.log(`Added ${missing.length} missing standard work type(s).`);
  }

  /** Connector keys saved before encryption was added are plain text. Encrypt them once, on boot. */
  private async encryptLegacySecrets() {
    const rows = await this.db.execute<{ kind: string; secret: string }>(
      sql`select kind, secret from mail.connectors where secret is not null and secret not like 'enc:v1:%'`,
    );
    for (const row of rows) {
      await this.db.execute(sql`update mail.connectors set secret = ${seal(row.secret)} where kind = ${row.kind}`);
    }
    if (rows.length > 0) this.log.log(`Encrypted ${rows.length} stored connector key(s).`);
  }

  private async userCount() {
    const rows = await this.db.execute<{ n: number }>(sql`select count(*)::int as n from identity.users`);
    const first = rows[0];
    return Number(first?.n ?? 0);
  }
}
