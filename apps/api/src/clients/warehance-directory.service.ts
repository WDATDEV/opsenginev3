import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { clientRecords, connectors, employees } from "@opsengine/db";
import { eq } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { WarehanceClient } from "../mail/warehance-client.js";

export const WAREHANCE_CLIENT_SERVICES = ["jobs", "unloading", "people", "reports", "invoices"] as const;

const PULL_MS = 5 * 60_000;

@Injectable()
export class WarehanceDirectoryService {
  private readonly log = new Logger("WarehanceDirectory");
  private lastPull = 0;
  private pulling: Promise<void> | null = null;

  constructor(@Inject(DbService) private readonly db: DbService) {}

  async refreshQuietly() {
    if (Date.now() - this.lastPull < PULL_MS) return;
    if (this.pulling) return this.pulling;
    this.pulling = this.pull()
      .catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Could not load Warehance clients."))
      .finally(() => {
        this.pulling = null;
      });
    return this.pulling;
  }

  async refreshNow() {
    this.lastPull = 0;
    if (this.pulling) await this.pulling;
    try {
      const result = await this.pull();
      if (!result) throw new BadRequestException("The Warehance bot is not connected. Add it in Settings.");
      if (result.clients === 0) return { message: "Warehance returned no clients." };
      const people = result.people > 0 ? ` ${result.people} people.` : " People were added when Warehance sent them.";
      return { message: `Loaded ${result.clients} client(s) from Warehance.${people}` };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(err instanceof Error ? err.message : "Could not load Warehance clients.");
    }
  }

  private async pull() {
    const [bot] = await this.db.db.select().from(connectors).where(eq(connectors.kind, "warehance")).limit(1);
    if (!bot?.extra || !bot.secret) return null;
    const mcp = new WarehanceClient(bot.extra, bot.secret);
    const remote = await listWarehanceClients(mcp);
    if (remote.length === 0) {
      this.lastPull = Date.now();
      return { clients: 0, people: 0 };
    }
    const tools = await mcp.listTools().catch(() => []);
    const userTool = tools.find((tool) => tool.name === "search_users" || tool.name === "list_users" || tool.name === "search_client_users");
    const extraUsers = userTool ? await listUsers(mcp, userTool.name) : [];

    const existing = await this.db.db.select().from(clientRecords);
    let people = 0;
    for (const brand of remote) {
      const row = await this.upsertClient(brand, existing);
      const list = [...peopleOf(brand.raw), ...extraUsers.filter((person) => person.clientId === brand.id)];
      people += list.length;
      for (const person of list) await this.upsertPerson(row.id, person);
    }
    this.lastPull = Date.now();
    return { clients: remote.length, people };
  }

  private async upsertClient(brand: { id: number; name: string }, existing: (typeof clientRecords.$inferSelect)[]) {
    const byId = existing.find((row) => row.warehanceClientId === brand.id);
    const byName = existing.find((row) => row.name.trim().toLowerCase() === brand.name.trim().toLowerCase());
    const hit = byId ?? byName;
    if (hit) {
      const firstLink = hit.warehanceClientId == null;
      const next = {
        name: brand.name,
        warehanceClientId: brand.id,
        enabledServices:
          firstLink || hit.enabledServices.length === 0 ? [...WAREHANCE_CLIENT_SERVICES] : hit.enabledServices,
      };
      await this.db.db.update(clientRecords).set(next).where(eq(clientRecords.id, hit.id));
      Object.assign(hit, next);
      return hit;
    }
    const created = await this.db.db
      .insert(clientRecords)
      .values({
        name: brand.name,
        code: await this.uniqueCode(brand.name, existing),
        warehanceClientId: brand.id,
        enabledServices: [...WAREHANCE_CLIENT_SERVICES],
      })
      .returning();
    const row = created[0];
    if (!row) throw new Error("Could not add a Warehance client.");
    existing.push(row);
    return row;
  }

  private async uniqueCode(name: string, existing: { code: string }[]) {
    const used = new Set(existing.map((row) => row.code.toUpperCase()));
    const base = codeFrom(name);
    if (!used.has(base)) return base;
    for (let n = 2; n < 100; n += 1) {
      const next = `${base.slice(0, 6)}${n}`.slice(0, 8).toUpperCase();
      if (!used.has(next)) return next;
    }
    return `W${Date.now().toString(36).slice(-7)}`.toUpperCase();
  }

  private async upsertPerson(clientId: string, person: { id: string; name: string }) {
    const warehanceUserId = person.id.slice(0, 80);
    const [hit] = await this.db.db.select().from(employees).where(eq(employees.warehanceUserId, warehanceUserId)).limit(1);
    if (hit) {
      await this.db.db
        .update(employees)
        .set({ name: person.name, clientId, departmentHome: "unloading", departments: ["unloading"], active: true })
        .where(eq(employees.id, hit.id));
      return;
    }
    const badge = await this.uniqueBadge(`W${warehanceUserId}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "WUSER");
    await this.db.db.insert(employees).values({
      name: person.name.slice(0, 80),
      badgeCode: badge,
      departmentHome: "unloading",
      departments: ["unloading"],
      employmentType: "employee",
      warehanceUserId,
      clientId,
      active: true,
    });
  }

  private async uniqueBadge(seed: string) {
    const base = seed.toUpperCase().slice(0, 20);
    for (let n = 0; n < 50; n += 1) {
      const code = n === 0 ? base : `${base.slice(0, 16)}${n}`.slice(0, 20);
      const [hit] = await this.db.db.select({ id: employees.id }).from(employees).where(eq(employees.badgeCode, code)).limit(1);
      if (!hit) return code;
    }
    return `W${Date.now().toString(36)}`.toUpperCase().slice(0, 20);
  }
}

async function listWarehanceClients(mcp: WarehanceClient) {
  const found: { id: number; name: string; raw: Record<string, unknown> }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const args: Record<string, unknown> = { limit: 50 };
    if (cursor) args.cursor = cursor;
    const { data, failed } = await mcp.call("list_clients", args);
    if (failed) {
      if (page === 0) throw new Error(typeof data === "string" ? data : "The Warehance bot could not list clients.");
      break;
    }
    const body = asObj(data);
    const records = Array.isArray(body.records) ? body.records : Array.isArray(data) ? data : [];
    for (const item of records) {
      const raw = asObj(item);
      const id = Number(raw.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      found.push({ id, name: String(raw.name ?? raw.company_name ?? `Client ${id}`).trim() || `Client ${id}`, raw });
    }
    cursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
    if (!cursor) break;
  }
  return found;
}

async function listUsers(mcp: WarehanceClient, tool: string) {
  const { data, failed } = await mcp.call(tool, { limit: 100 });
  if (failed) return [];
  const body = asObj(data);
  const records = Array.isArray(body.records) ? body.records : Array.isArray(data) ? data : [];
  const out: { id: string; name: string; clientId: number }[] = [];
  for (const item of records) {
    const raw = asObj(item);
    const clientId = Number(raw.client_id ?? asObj(raw.client).id);
    const person = personOf(raw);
    if (!person || !Number.isInteger(clientId) || clientId <= 0) continue;
    out.push({ ...person, clientId });
  }
  return out;
}

function peopleOf(record: Record<string, unknown>) {
  const bags = [record.users, record.contacts, record.people, record.members, record.client_users];
  const out: { id: string; name: string }[] = [];
  for (const bag of bags) {
    if (!Array.isArray(bag)) continue;
    for (const item of bag) {
      const person = personOf(asObj(item));
      if (person) out.push(person);
    }
  }
  return out;
}

function personOf(raw: Record<string, unknown>) {
  const id = raw.id ?? raw.user_id ?? raw.email;
  const name =
    text(raw.name) ||
    [text(raw.first_name), text(raw.last_name)].filter(Boolean).join(" ") ||
    text(raw.email);
  if (id == null || !name) return null;
  return { id: String(id), name };
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function codeFrom(name: string) {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "WH";
  if (words.length === 1) return words[0]!.replace(/[^A-Z0-9]/g, "").slice(0, 8) || "WH";
  const initials = words.map((word) => word[0]).join("");
  return (initials.length >= 2 ? initials : words[0]!).slice(0, 8);
}
