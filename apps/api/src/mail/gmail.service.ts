import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { connectors, letters } from "@opsengine/db";
import { desc, eq } from "drizzle-orm";
import { DbService } from "../db.service.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  headers?: { name: string; value: string }[];
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPart;
};

function clientId() {
  return process.env.GOOGLE_CLIENT_ID ?? "";
}

function clientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET ?? "";
}

function decode(data: string) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Prefer the plain-text part of the letter; fall back to the HTML part with tags removed.
function bodyOf(part: GmailPart | undefined): string {
  if (!part) return "";
  const plain = find(part, "text/plain");
  if (plain) return plain.trim();
  const html = find(part, "text/html");
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function find(part: GmailPart, mime: string): string {
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = find(child, mime);
    if (found) return found;
  }
  return "";
}

function header(part: GmailPart | undefined, name: string) {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function sender(value: string) {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || null, email: (match[2] ?? "").trim().toLowerCase() };
  return { name: null, email: value.trim().toLowerCase() };
}

@Injectable()
export class GmailService {
  private readonly log = new Logger("Gmail");
  private syncing = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  configured() {
    return Boolean(clientId() && clientSecret());
  }

  redirectUri(req: { headers: Record<string, string | string[] | undefined>; protocol: string }) {
    if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
    const proto = first(req.headers["x-forwarded-proto"]) ?? req.protocol;
    const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host);
    return `${proto}://${host}/auth/google/callback`;
  }

  connectUrl(userId: string, redirectUri: string) {
    if (!this.configured()) {
      throw new BadRequestException("Google sign-in is not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the API.");
    }
    const state = this.jwt.sign({ purpose: "gmail", uid: userId }, { expiresIn: "10m" });
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  // Google sends the owner back here with a one-time code. Trade it for a long-lived token and keep that.
  async finishConnect(code: string, state: string, redirectUri: string) {
    try {
      const payload = this.jwt.verify<{ purpose?: string }>(state);
      if (payload.purpose !== "gmail") throw new Error("wrong state");
    } catch {
      throw new BadRequestException("The sign-in link expired. Start again from Settings.");
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!res.ok || !tokens.access_token) {
      throw new BadRequestException(`Google did not accept the sign-in (${tokens.error ?? res.status}).`);
    }
    if (!tokens.refresh_token) {
      throw new BadRequestException("Google did not return a long-lived token. Remove Ops Engine from your Google account access and connect again.");
    }

    const profile = await this.get<{ emailAddress: string }>("users/me/profile", tokens.access_token);
    await this.save(profile.emailAddress, tokens.refresh_token, "Signed in with Google. New mail is checked every minute.");
    return profile.emailAddress;
  }

  async test() {
    const token = await this.accessToken();
    const profile = await this.get<{ emailAddress: string }>("users/me/profile", token);
    await this.note(`Google accepted the sign-in for ${profile.emailAddress}.`);
  }

  async list() {
    return this.db.db.select().from(letters).orderBy(desc(letters.receivedAt)).limit(50);
  }

  // Pull recent inbox letters. A letter already stored is skipped, so running this again is safe.
  async sync() {
    if (this.syncing) return { added: 0, skipped: true };
    const [row] = await this.db.db.select().from(connectors).where(eq(connectors.kind, "gmail")).limit(1);
    if (!row?.secret) return { added: 0, skipped: true };

    this.syncing = true;
    try {
      const token = await this.accessToken();
      const found = await this.get<{ messages?: { id: string }[] }>(
        "users/me/messages?q=in%3Ainbox%20newer_than%3A7d&maxResults=25",
        token,
      );
      let added = 0;
      for (const { id } of found.messages ?? []) {
        const message = await this.get<GmailMessage>(`users/me/messages/${id}?format=full`, token);
        const from = sender(header(message.payload, "From"));
        if (!from.email) continue;
        const inserted = await this.db.db
          .insert(letters)
          .values({
            gmailId: message.id,
            threadId: message.threadId,
            fromEmail: from.email,
            fromName: from.name,
            subject: header(message.payload, "Subject").slice(0, 500),
            body: bodyOf(message.payload).slice(0, 20_000),
            receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : new Date(),
          })
          .onConflictDoNothing({ target: letters.gmailId })
          .returning({ id: letters.id });
        added += inserted.length;
      }
      if (added > 0) this.log.log(`Saved ${added} new letter(s).`);
      return { added, skipped: false };
    } finally {
      this.syncing = false;
    }
  }

  private async accessToken() {
    const [row] = await this.db.db.select().from(connectors).where(eq(connectors.kind, "gmail")).limit(1);
    if (!row?.secret) throw new BadRequestException("Connect Gmail first.");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: row.secret,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant") await this.note("Google sign-in expired. Connect Gmail again.");
      throw new BadRequestException("Google rejected the saved sign-in. Connect Gmail again.");
    }
    return body.access_token;
  }

  private async get<T>(path: string, token: string): Promise<T> {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new BadRequestException(`Gmail answered ${res.status}.`);
    return (await res.json()) as T;
  }

  private async save(email: string, refreshToken: string, detail: string) {
    await this.db.db
      .insert(connectors)
      .values({ kind: "gmail", label: email, secret: refreshToken, extra: null, detail })
      .onConflictDoUpdate({
        target: connectors.kind,
        set: { label: email, secret: refreshToken, extra: null, detail, updatedAt: new Date() },
      });
  }

  private async note(detail: string) {
    await this.db.db.update(connectors).set({ detail, updatedAt: new Date() }).where(eq(connectors.kind, "gmail"));
  }
}
