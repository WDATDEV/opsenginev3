import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { connectors } from "@opsengine/db";
import { eq } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { checkKey, modelFor } from "../mail/anthropic.js";
import { GmailService } from "../mail/gmail.service.js";
import { refuseSameKeys, refuseStaffKey, refuseWriteKey } from "../mail/settings-keys.js";
import { WarehanceClient } from "../mail/warehance-client.js";

type Kind = "gmail" | "warehance" | "warehance_write" | "slack" | "anthropic";

type ConnectorRow = typeof connectors.$inferSelect;

function view(row: ConnectorRow | undefined) {
  return {
    connected: Boolean(row?.label || row?.secret),
    label: row?.label ?? null,
    detail: row?.detail ?? null,
    address: row?.kind === "warehance" ? row.extra ?? null : null,
  };
}

// True once the Google client id and secret are set on the API.
function googleReady() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(GmailService) private readonly gmail: GmailService,
  ) {}

  async list() {
    const rows = await this.db.db.select().from(connectors);
    return {
      gmail: { ...view(rows.find((row) => row.kind === "gmail")), googleReady: googleReady() },
      warehance: view(rows.find((row) => row.kind === "warehance")),
      warehanceWrite: view(rows.find((row) => row.kind === "warehance_write")),
      slack: view(rows.find((row) => row.kind === "slack")),
      anthropic: view(rows.find((row) => row.kind === "anthropic")),
    };
  }

  async status() {
    const all = await this.list();
    return {
      gmail: all.gmail.connected,
      warehance: all.warehance.connected,
      slack: all.slack.connected,
      // A key set as ANTHROPIC_API_KEY on the API also counts.
      claude: all.anthropic.connected || Boolean(process.env.ANTHROPIC_API_KEY),
    };
  }

  async saveAnthropic(key: string) {
    const stored = key || (await this.secret("anthropic"));
    if (!stored) throw new BadRequestException("Paste the Claude API key.");
    await this.upsert("anthropic", {
      label: "API key saved",
      secret: stored,
      extra: null,
      detail: "Saved. Test it to confirm Anthropic accepts the key.",
    });
    return this.list();
  }

  async saveWarehance(url: string, key: string) {
    const stored = key || (await this.secret("warehance"));
    if (!stored) throw new BadRequestException("Paste the staff key.");
    const tools = await listConnectorTools(url, stored);
    const blocked = refuseStaffKey(tools) || refuseSameKeys(stored, await this.secret("warehance_write"));
    if (blocked) throw new BadRequestException(blocked);
    await this.upsert("warehance", {
      label: hostOf(url),
      secret: stored,
      extra: url,
      detail: "Saved. Test the connection before Mail uses it.",
    });
    return this.list();
  }

  async saveWarehanceWrite(url: string, key: string) {
    const staff = await this.row("warehance");
    const mcp = url || staff?.extra || "";
    const stored = key || (await this.secret("warehance_write"));
    if (!stored) throw new BadRequestException("Paste the Warehance write key.");
    if (!mcp) throw new BadRequestException("Save the Warehance bot address first, or paste the connector URL.");
    const tools = await listConnectorTools(mcp, stored);
    const blocked = refuseWriteKey(tools) || refuseSameKeys(await this.secret("warehance"), stored);
    if (blocked) throw new BadRequestException(blocked);
    await this.upsert("warehance_write", {
      label: "Write key saved",
      secret: stored,
      extra: mcp,
      detail: "Saved. Confirm uses this key only after the owner presses Confirm.",
    });
    return this.list();
  }

  async saveSlack(token: string, channel: string) {
    const stored = token || (await this.secret("slack"));
    if (!stored) throw new BadRequestException("Paste the Slack bot token.");
    // Only the bot token is required. The channel is an optional default, because each rule picks its own channels.
    await this.upsert("slack", {
      label: channel || "Bot token saved",
      secret: stored,
      extra: channel || null,
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
      // Asks Google for the mailbox profile with the saved token, so it proves the sign-in still works.
      await this.gmail.test();
      return this.list();
    }
    if (kind === "warehance") {
      let detail: string;
      try {
        const client = new WarehanceClient(row.extra || "", row.secret || "");
        const tools = await client.listTools();
        const blocked = refuseStaffKey(tools);
        if (blocked) throw new Error(blocked);
        detail = await client.check();
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : "Could not reach the Warehance connector.");
      }
      await this.upsert("warehance", { ...row, detail });
      return this.list();
    }
    if (kind === "warehance_write") {
      let detail: string;
      try {
        const client = new WarehanceClient(row.extra || "", row.secret || "");
        const tools = await client.listTools();
        const blocked = refuseWriteKey(tools);
        if (blocked) throw new Error(blocked);
        detail = `Connected. Write key has adjust_inventory. ${tools.length} tool(s) listed.`;
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : "Could not reach the Warehance connector.");
      }
      await this.upsert("warehance_write", { ...row, detail });
      return this.list();
    }
    if (kind === "anthropic") {
      const model = modelFor("haiku");
      try {
        await checkKey(row.secret || "", model);
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : "Could not reach Anthropic.");
      }
      await this.upsert("anthropic", { ...row, detail: `Anthropic accepted the key. Drafts use ${model}.` });
      return this.list();
    }
    const detail = await pingSlack(row.secret || "", row.extra || "");
    await this.upsert("slack", { ...row, label: row.extra || "Bot token saved", detail });
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

async function listConnectorTools(url: string, key: string) {
  try {
    return await new WarehanceClient(url, key).listTools();
  } catch (err) {
    throw new BadRequestException(err instanceof Error ? err.message : "Could not reach the Warehance connector.");
  }
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
  const where = channel ? `Default channel is ${channel}.` : "Each rule chooses its own channels.";
  return `Slack workspace ${body.team ?? "connected"} accepted the bot token. ${where}`;
}
