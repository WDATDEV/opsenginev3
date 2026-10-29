import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { clientRecords, tasks } from "@opsengine/db";
import { assertClientVisible, canSeeClient, type Principal } from "@opsengine/kernel";
import { DbService } from "../db.service.js";

@Injectable()
export class WorkService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(principal: Principal) {
    const [rows, clients] = await Promise.all([
      this.db.db.select().from(tasks).orderBy(desc(tasks.createdAt)),
      this.db.db.select().from(clientRecords),
    ]);
    const names = new Map(clients.map((client) => [client.id, client.name]));
    return rows
      .filter((row) => !row.jobId)
      .filter((row) => (row.clientId ? canSeeClient(principal, row.clientId) : principal.role !== "client_services"))
      .map((row) => ({
        ...row,
        clientName: row.clientId ? names.get(row.clientId) ?? null : null,
      }));
  }

  async complete(principal: Principal, id: string) {
    const [existing] = await this.db.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!existing) throw new NotFoundException("That follow-up is not on the board.");
    if (existing.clientId) assertClientVisible(principal, existing.clientId);
    if (existing.dependsOnId) {
      const [earlier] = await this.db.db.select().from(tasks).where(eq(tasks.id, existing.dependsOnId)).limit(1);
      if (earlier && earlier.status !== "done") {
        throw new ConflictException(`Finish ${earlier.title} before closing this task.`);
      }
    }
    await this.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    return { message: "Follow-up closed." };
  }
}
