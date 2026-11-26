import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { activity, employeePhones, employees } from "@opsengine/db";
import type { Principal } from "@opsengine/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { hashDeviceToken, newDeviceToken } from "./floor-access.js";

const SEEN_EVERY_MS = 5 * 60_000;
/** A phone link works once, within a day of being made. */
export const PHONE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export type LinkedPhone = { id: string; employeeId: string; name: string; badgeCode: string };

@Injectable()
export class EmployeePhonesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** The employee a phone is tied to, or null. A removed phone or a deactivated person gets nothing. */
  async find(token: string | undefined): Promise<LinkedPhone | null> {
    if (!token) return null;
    const [row] = await this.db.db
      .select({ phone: employeePhones, employee: employees })
      .from(employeePhones)
      .innerJoin(employees, eq(employees.id, employeePhones.employeeId))
      .where(and(eq(employeePhones.tokenHash, hashDeviceToken(token)), isNull(employeePhones.revokedAt)))
      .limit(1);
    if (!row || !row.employee.active) return null;
    if (!row.phone.lastSeenAt || Date.now() - row.phone.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await this.db.db.update(employeePhones).set({ lastSeenAt: new Date() }).where(eq(employeePhones.id, row.phone.id));
    }
    return { id: row.phone.id, employeeId: row.employee.id, name: row.employee.name, badgeCode: row.employee.badgeCode };
  }

  /** A one-time link for one employee. Only its hash is stored. */
  async createLink(principal: Principal, employeeId: string) {
    const employee = await this.employee(employeeId);
    if (!employee.active) throw new ConflictException(`${employee.name} is inactive. Turn them back on first.`);
    const token = newDeviceToken();
    const expiresAt = new Date(Date.now() + PHONE_LINK_TTL_MS);
    const [row] = await this.db.db
      .insert(employeePhones)
      .values({ employeeId, inviteHash: hashDeviceToken(token), inviteExpiresAt: expiresAt, createdBy: principal.id })
      .returning({ id: employeePhones.id });
    if (!row) throw new ConflictException("Could not make a phone link.");
    await this.record(principal.id, "tracking.phone_link_created", row.id, `${principal.name} made a phone link for ${employee.name}.`);
    return { token, expiresAt, name: employee.name };
  }

  /** Opening the link ties this phone to the employee. The link cannot be used again. */
  async claim(inviteToken: string, onApprovedStation: boolean) {
    if (onApprovedStation) {
      throw new ForbiddenException("This is a shared station iPad. Open your phone link on your own phone.");
    }
    const [row] = await this.db.db
      .select({ phone: employeePhones, employee: employees })
      .from(employeePhones)
      .innerJoin(employees, eq(employees.id, employeePhones.employeeId))
      .where(eq(employeePhones.inviteHash, hashDeviceToken(inviteToken)))
      .limit(1);
    const expired = !row?.phone.inviteExpiresAt || row.phone.inviteExpiresAt.getTime() < Date.now();
    if (!row || row.phone.revokedAt || row.phone.tokenHash || expired) {
      throw new NotFoundException("This phone link has expired or was already used. Ask a manager for a new one.");
    }
    if (!row.employee.active) throw new ForbiddenException("This person is not on the floor. Ask a manager.");
    const token = newDeviceToken();
    const now = new Date();
    // inviteHash is cleared in the same write, so the link works once even if opened twice at the same moment.
    const [claimed] = await this.db.db
      .update(employeePhones)
      .set({ tokenHash: hashDeviceToken(token), inviteHash: null, claimedAt: now, lastSeenAt: now })
      .where(and(eq(employeePhones.id, row.phone.id), isNull(employeePhones.tokenHash)))
      .returning({ id: employeePhones.id });
    if (!claimed) throw new NotFoundException("This phone link was already used. Ask a manager for a new one.");
    await this.record(null, "tracking.phone_linked", row.phone.id, `${row.employee.name} linked their phone.`);
    return { token, name: row.employee.name };
  }

  /** Phones tied to one employee, and links not yet opened. */
  async list(employeeId: string) {
    await this.employee(employeeId);
    const rows = await this.db.db
      .select()
      .from(employeePhones)
      .where(and(eq(employeePhones.employeeId, employeeId), isNull(employeePhones.revokedAt)))
      .orderBy(desc(employeePhones.createdAt));
    const now = Date.now();
    return rows
      .filter((row) => row.tokenHash || (row.inviteExpiresAt && row.inviteExpiresAt.getTime() > now))
      .map((row) => ({
        id: row.id,
        linked: Boolean(row.tokenHash),
        createdAt: row.createdAt,
        claimedAt: row.claimedAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.tokenHash ? null : row.inviteExpiresAt,
      }));
  }

  async revoke(principal: Principal | null, id: string, by: string) {
    const [row] = await this.db.db
      .select({ phone: employeePhones, employee: employees })
      .from(employeePhones)
      .innerJoin(employees, eq(employees.id, employeePhones.employeeId))
      .where(eq(employeePhones.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("That phone is not on file.");
    if (row.phone.revokedAt) return { message: "That phone is already removed." };
    await this.db.db.update(employeePhones).set({ revokedAt: new Date(), inviteHash: null }).where(eq(employeePhones.id, id));
    await this.record(principal?.id ?? null, "tracking.phone_removed", id, `${by} removed a phone from ${row.employee.name}.`);
    return { message: `That phone can no longer record ${row.employee.name}'s time.` };
  }

  private async employee(id: string) {
    const [row] = await this.db.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    if (!row) throw new NotFoundException("That person is not on file.");
    return row;
  }

  private async record(actorId: string | null, action: string, entityId: string, summary: string) {
    await this.db.db.insert(activity).values({
      actorId,
      action,
      module: "tracking",
      entityType: "employee_phone",
      entityId,
      after: { summary },
    });
  }
}
