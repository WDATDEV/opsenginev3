import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { appSections, resolveSections, type AppSection, type Role } from "@opsengine/contracts";
import { users } from "@opsengine/db";
import { hash } from "bcryptjs";
import { desc, eq } from "drizzle-orm";
import { ForbiddenError, type Principal } from "@opsengine/kernel";
import { DbService } from "../db.service.js";

const STAFF: Role[] = ["warehouse_manager", "warehouse_employee", "client_services", "hr_finance", "external_customer"];

export type UserInput = {
  name: string;
  email: string;
  password?: string;
  role: Role;
  sections: AppSection[];
  clientIds?: string[] | null;
};

function publicUser(row: typeof users.$inferSelect) {
  const role = row.role as Role;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    clientIds: row.clientIds,
    sections: resolveSections(role, row.sections),
    createdAt: row.createdAt,
  };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list() {
    const rows = await this.db.db.select().from(users).orderBy(desc(users.createdAt));
    return rows.map(publicUser);
  }

  async create(actor: Principal, input: UserInput) {
    this.guard(actor, input, null);
    if (!input.password) throw new BadRequestException("Set a password for the new user.");
    const email = input.email.trim().toLowerCase();
    const [exists] = await this.db.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (exists) throw new BadRequestException("That email already has an account.");
    const [row] = await this.db.db
      .insert(users)
      .values({
        name: input.name.trim(),
        email,
        passwordHash: await hash(input.password, 10),
        role: input.role,
        sections: input.role === "owner" ? null : input.sections,
        clientIds: this.clientsFor(input.role, input.clientIds),
      })
      .returning();
    return publicUser(row!);
  }

  async update(actor: Principal, id: string, input: UserInput) {
    const [row] = await this.db.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new NotFoundException("That user was not found.");
    this.guard(actor, input, row);
    const email = input.email.trim().toLowerCase();
    const patch: Partial<typeof users.$inferInsert> = {
      name: input.name.trim(),
      email,
      role: input.role,
      sections: input.role === "owner" ? null : input.sections,
      clientIds: this.clientsFor(input.role, input.clientIds),
    };
    if (input.password) patch.passwordHash = await hash(input.password, 10);
    const [saved] = await this.db.db.update(users).set(patch).where(eq(users.id, id)).returning();
    return publicUser(saved!);
  }

  async remove(actor: Principal, id: string) {
    const [row] = await this.db.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new NotFoundException("That user was not found.");
    if (row.id === actor.id) throw new ForbiddenError("You cannot remove your own account.");
    if (row.role === "owner") throw new ForbiddenError("The owner account cannot be removed.");
    await this.db.db.delete(users).where(eq(users.id, id));
    return { ok: true };
  }

  private clientsFor(role: Role, clientIds?: string[] | null) {
    if (role === "external_customer" || role === "client_services") {
      return clientIds && clientIds.length > 0 ? clientIds : [];
    }
    return null;
  }

  private guard(actor: Principal, input: UserInput, existing: typeof users.$inferSelect | null) {
    if (input.role === "owner") throw new ForbiddenError("There is already an owner. Pick another role.");
    if (!STAFF.includes(input.role)) throw new BadRequestException("That role cannot be assigned.");
    if (existing?.role === "owner") throw new ForbiddenError("The owner account cannot be changed here.");
    const allowed = new Set<string>(appSections);
    const sections = input.sections.filter((item) => allowed.has(item));
    if (sections.length === 0) throw new BadRequestException("Turn on at least one section.");
    input.sections = sections;
    if (actor.role !== "owner") {
      if (sections.includes("users") || sections.includes("settings")) {
        throw new ForbiddenError("Only the owner can grant Users or Settings.");
      }
    }
  }
}
