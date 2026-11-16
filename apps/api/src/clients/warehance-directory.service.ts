import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { clientRecords, connectors, employees } from "@opsengine/db";
import { eq } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { WarehanceClient } from "../mail/warehance-client.js";
import { LIST_PAGE_CAP, LIST_PAGE_SIZE, asObj, listPageArgs, nextListPage, recordsOf } from "./warehance-pages.js";

export const WAREHANCE_CLIENT_SERVICES = ["jobs", "unloading", "people", "reports", "invoices"] as const;

@Injectable()
export class WarehanceDirectoryService {
  private pulling: Promise<unknown> | null = null;

  constructor(@Inject(DbService) private readonly db: DbService) {}

  async refreshNow() {
    if (this.pulling) await this.pulling;
    this.pulling = this.pull().finally(() => {
      this.pulling = null;
    });
    try {
      const result = await this.pulling;
      if (!result) throw new BadRequestException("The Warehance bot is not connected. Add it in Settings.");
      if (result.clients === 0) return { message: "Warehance returned no clients." };
      const people =
        result.people > 0
          ? ` ${result.people} people.`
          : result.userFail
            ? " People could not be loaded. The staff key may lack read_users, or the connector needs a restart after adding list_users."
            : result.userTool
              ? " Warehance returned no people for those brands."
              : " People were not loaded: the Warehance bot has no users tool. Add list_users (GET /users) to the staff key and restart the connector.";
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
      return { clients: 0, people: 0, userTool: false, userFail: false };
    }
    const tools = await mcp.listTools().catch(() => []);
    const userTool = pickUserTool(tools);

    const existing = await this.db.db.select().from(clientRecords);
    const rows: { brand: { id: number; name: string; raw: Record<string, unknown> }; row: (typeof clientRecords.$inferSelect) }[] = [];
    for (const brand of remote) {
      const row = await this.upsertClient(brand, existing);
      if (row) rows.push({ brand, row });
    }
    let people = 0;
    let userFail = false;
    for (const item of rows) {
      if (item.row.hidden) continue;
      const fromClient = peopleOf(item.brand.raw);
      let fromUsers: { id: string; name: string }[] = [];
      if (userTool) {
        const pulled = await listUsers(mcp, userTool.name, item.brand.id);
        fromUsers = pulled.people;
        if (pulled.failed) userFail = true;
      }
      const list = uniquePeople([...fromClient, ...fromUsers]);
      people += list.length;
      for (const person of list) await this.upsertPerson(item.row.id, person);
    }
    return { clients: remote.length, people, userTool: Boolean(userTool), userFail };
  }

  private async upsertClient(brand: { id: number; name: string }, existing: (typeof clientRecords.$inferSelect)[]) {
    const byId = existing.find((row) => row.warehanceClientId === brand.id);
    const byName = existing.find(
      (row) =>
        row.name.trim().toLowerCase() === brand.name.trim().toLowerCase() &&
        (row.warehanceClientId == null || row.warehanceClientId === brand.id),
    );
    const hit = byId ?? byName;
    if (hit) {
      if (hit.hidden) {
        if (hit.warehanceClientId == null) {
          await this.db.db.update(clientRecords).set({ warehanceClientId: brand.id }).where(eq(clientRecords.id, hit.id));
          hit.warehanceClientId = brand.id;
        }
        return hit;
      }
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
  const seen = new Set<number>();
  let cursor: string | undefined;
  let offset = 0;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const { data, failed } = await mcp.call("list_clients", listPageArgs(LIST_PAGE_SIZE, cursor, offset));
    if (failed) {
      if (page === 0) throw new Error(typeof data === "string" ? data : "The Warehance bot could not list clients.");
      break;
    }
    const records = recordsOf(data);
    let added = 0;
    for (const item of records) {
      const raw = asObj(item);
      const id = Number(raw.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      added += 1;
      found.push({ id, name: String(raw.name ?? raw.company_name ?? `Client ${id}`).trim() || `Client ${id}`, raw });
    }
    const next = nextListPage(data, records.length, LIST_PAGE_SIZE, offset);
    if (!next || added === 0) break;
    cursor = next.cursor;
    offset = next.offset ?? offset + records.length;
  }
  return found;
}

function pickUserTool(tools: { name: string }[]) {
  const names = ["list_users", "search_users", "search_client_users", "get_users"];
  return tools.find((tool) => names.includes(tool.name)) ?? tools.find((tool) => /user/.test(tool.name) && /list|search/.test(tool.name));
}

async function listUsers(mcp: WarehanceClient, tool: string, clientId: number) {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let offset = 0;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const args = { ...listPageArgs(LIST_PAGE_SIZE, cursor, offset), client_id: clientId };
    const { data, failed } = await mcp.call(tool, args);
    if (failed) return { people: out, failed: page === 0 };
    const records = recordsOf(data);
    let added = 0;
    for (const item of records) {
      const person = personOf(asObj(item));
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      added += 1;
      out.push(person);
    }
    const next = nextListPage(data, records.length, LIST_PAGE_SIZE, offset);
    if (!next || added === 0) break;
    cursor = next.cursor;
    offset = next.offset ?? offset + records.length;
  }
  return { people: out, failed: false };
}

function uniquePeople(list: { id: string; name: string }[]) {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const person of list) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    out.push(person);
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
