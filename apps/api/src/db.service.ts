import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { createDb, ensureSchema, type Database } from "@opsengine/db";

@Injectable()
export class DbService implements OnModuleInit {
  readonly db: Database = createDb();

  async onModuleInit() {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    try {
      await ensureSchema(url);
    } catch (err) {
      new Logger("Database").error(`Could not update the database tables: ${err instanceof Error ? err.message : err}`);
    }
  }
}
