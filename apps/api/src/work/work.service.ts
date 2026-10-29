import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { clientRecords, tasks } from "@opsengine/db";
import { DbService } from "../db.service.js";

@Injectable()
export class WorkService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list() {
    const [rows, clients] = await Promise.all([
      this.db.db.select().from(tasks).orderBy(desc(tasks.createdAt)),
      this.db.db.select().from(clientRecords),
    ]);
    const names = new Map(clients.map((client) => [client.id, client.name]));
    return rows.map((row) => ({
      ...row,
      clientName: row.clientId ? names.get(row.clientId) ?? null : null,
    }));
  }

  async complete(id: string) {
    const [existing] = await this.db.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!existing) throw new NotFoundException("That follow-up is not on the board.");
    await this.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    return { message: "Follow-up closed." };
  }
}
