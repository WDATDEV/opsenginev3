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
