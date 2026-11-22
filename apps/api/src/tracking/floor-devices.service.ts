import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { activity, floorDevices } from "@opsengine/db";
import type { Principal } from "@opsengine/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { hashDeviceToken, newDeviceToken } from "./floor-access.js";

const SEEN_EVERY_MS = 5 * 60_000;

@Injectable()
export class FloorDevicesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** The approved device behind a token, or null. Stored tokens are hashed. */
  async find(token: string | undefined) {
    if (!token) return null;
    const [row] = await this.db.db
      .select()
      .from(floorDevices)
      .where(and(eq(floorDevices.tokenHash, hashDeviceToken(token)), isNull(floorDevices.revokedAt)))
      .limit(1);
    if (!row) return null;
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await this.db.db.update(floorDevices).set({ lastSeenAt: new Date() }).where(eq(floorDevices.id, row.id));
    }
    return row;
  }

  async list(currentToken: string | undefined) {
    const currentHash = currentToken ? hashDeviceToken(currentToken) : null;
    const rows = await this.db.db.select().from(floorDevices).orderBy(desc(floorDevices.createdAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      revokedAt: row.revokedAt,
      current: row.tokenHash === currentHash,
    }));
  }

  async register(principal: Principal, name: string, currentToken: string | undefined) {
    if (await this.find(currentToken)) throw new ConflictException("This device is already approved.");
    const token = newDeviceToken();
    const [row] = await this.db.db
      .insert(floorDevices)
      .values({ name: name.trim(), tokenHash: hashDeviceToken(token), createdBy: principal.id, lastSeenAt: new Date() })
      .returning();
    if (!row) throw new ConflictException("Could not register this device.");
    await this.record(principal, "tracking.floor_device_registered", row.id, `${principal.name} approved floor device ${row.name}.`);
    return { token, message: `${row.name} is approved for floor scans.` };
  }

  async revoke(principal: Principal, id: string) {
    const [row] = await this.db.db.select().from(floorDevices).where(eq(floorDevices.id, id)).limit(1);
    if (!row) throw new NotFoundException("That device is not on file.");
    if (row.revokedAt) return { message: `${row.name} is already removed.` };
    await this.db.db.update(floorDevices).set({ revokedAt: new Date() }).where(eq(floorDevices.id, row.id));
    await this.record(principal, "tracking.floor_device_revoked", row.id, `${principal.name} removed floor device ${row.name}.`);
    return { message: `${row.name} can no longer record floor work.` };
  }

  private async record(principal: Principal, action: string, entityId: string, summary: string) {
    await this.db.db.insert(activity).values({
      actorId: principal.id,
      action,
      module: "tracking",
      entityType: "floor_device",
      entityId,
      after: { summary },
    });
  }
}
