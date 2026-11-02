import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { connectors } from "@opsengine/db";
import { eq } from "drizzle-orm";
import { DbService } from "../db.service.js";

type Kind = "gmail" | "warehance" | "slack";

type ConnectorRow = typeof connectors.$inferSelect;

function view(row: ConnectorRow | undefined) {
  return {
    connected: Boolean(row?.label || row?.secret),
    label: row?.label ?? null,
    detail: row?.detail ?? null,
    address: row?.kind === "warehance" ? row.extra ?? null : null,
  };
}

@Injectable()
export class SettingsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list() {
    const rows = await this.db.db.select().from(connectors);
    return {
      gmail: view(rows.find((row) => row.kind === "gmail")),
      warehance: view(rows.find((row) => row.kind === "warehance")),
      slack: view(rows.find((row) => row.kind === "slack")),
    };
  }

  async status() {
    const all = await this.list();
    return {
      gmail: all.gmail.connected,
      warehance: all.warehance.connected,
      slack: all.slack.connected,
    };
  }

  async saveGmail(email: string) {
    await this.upsert("gmail", { label: email, secret: null, extra: null, detail: "Mailbox saved. Replies send from this address." });
    return this.list();
  }

  async saveWarehance(url: string, key: string) {
    const stored = key || (await this.secret("warehance"));
    if (!stored) throw new BadRequestException("Paste the staff key.");
    await this.upsert("warehance", {
      label: hostOf(url),
      secret: stored,
      extra: url,
      detail: "Saved. Test the connection before Mail uses it.",
    });
    return this.list();
  }

  async saveSlack(token: string, channel: string) {
    const stored = token || (await this.secret("slack"));
    if (!stored) throw new BadRequestException("Paste the Slack bot token.");
    await this.upsert("slack", {
      label: channel,
      secret: stored,
      extra: channel,
      detail: "Saved. Test the connection before drafts go to Slack.",
    });
    return this.list();
  }

  async disconnect(kind: Kind) {
    await this.db.db.delete(connectors).where(eq(connectors.kind, kind));
    return this.list();
  }

  async test(kind: Kind) {
    const row = await this.row(kind);
    if (!row) throw new BadRequestException("Save this connector first.");
    if (kind === "gmail") {
      // Mailbox only. Google sign-in is a later step, so this test never calls Gmail.
      await this.upsert("gmail", { ...row, detail: `Mailbox ${row.label} is saved. Google sign-in is not connected yet.` });
      return this.list();
    }
    if (kind === "warehance") {
      const detail = await pingWarehance(row.extra || "", row.secret || "");
      await this.upsert("warehance", { ...row, detail });
      return this.list();
    }
    const detail = await pingSlack(row.secret || "", row.extra || "");
    await this.upsert("slack", { ...row, label: row.extra, detail });
    return this.list();
  }

  private async row(kind: Kind) {
    const [row] = await this.db.db.select().from(connectors).where(eq(connectors.kind, kind)).limit(1);
    return row;
  }

  private async secret(kind: Kind) {
    return (await this.row(kind))?.secret ?? "";
  }

  private async upsert(kind: Kind, fields: { label?: string | null; secret?: string | null; extra?: string | null; detail?: string | null }) {
    await this.db.db
      .insert(connectors)
      .values({
        kind,
        label: fields.label ?? null,
        secret: fields.secret ?? null,
        extra: fields.extra ?? null,
        detail: fields.detail ?? null,
      })
      .onConflictDoUpdate({
        target: connectors.kind,
        set: {
          label: fields.label ?? null,
          secret: fields.secret ?? null,
          extra: fields.extra ?? null,
          detail: fields.detail ?? null,
          updatedAt: new Date(),
        },
      });
  }
}

function hostOf(url: string) {
  return new URL(url).host;
}

async function pingWarehance(url: string, key: string) {
  let endpoint: string;
  try {
    const parsed = new URL(url);
    endpoint = parsed.pathname.endsWith("/mcp") ? parsed.toString() : new URL("/mcp", parsed.origin).toString();
  } catch {
    throw new BadRequestException("The Warehance connector address is not a valid URL.");
  }
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ops-engine", version: "0.0.1" },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new BadRequestException("Could not reach the Warehance connector.");
  }
  if (res.status === 401) throw new BadRequestException("The Warehance connector rejected the staff key.");
  if (!res.ok) throw new BadRequestException(`The Warehance connector answered ${res.status}.`);
  return "Warehance connector accepted the staff key.";
}

async function pingSlack(token: string, channel: string) {
  let res: Response;
  try {
    res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new BadRequestException("Could not reach Slack.");
  }
  const body = (await res.json()) as { ok?: boolean; error?: string; team?: string };
  if (!body.ok) throw new BadRequestException(body.error === "invalid_auth" ? "Slack rejected that bot token." : "Slack did not accept the bot token.");
  return `Slack workspace ${body.team ?? "connected"} accepted the bot token. Channel is set to ${channel}.`;
}
