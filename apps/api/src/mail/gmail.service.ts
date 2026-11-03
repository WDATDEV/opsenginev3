import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { connectors, letters, runs } from "@opsengine/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DbService } from "../db.service.js";
import { AutomationService } from "./automation.service.js";

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

// ---- Building the outgoing message (RFC 5322 / MIME) ----

// Header values must never hold a line break, or a sender could inject extra headers.
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
const encodeSubject = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);
const wrap64 = (base64: string) => (base64.match(/.{1,76}/g) ?? []).join("\r\n");
const toBase64Url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

export function buildReply(input: {
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
  attachment: { name: string; csv: string } | null;
  /** A new message, not a reply: the subject is used as written. */
  fresh?: boolean;
  /** Display name for the From line. The address is always the connected account. */
  from?: { name: string; email: string };
  replyTo?: string;
}) {
  const subject = oneLine(input.subject);
  const headers = [
    `To: ${oneLine(input.to)}`,
    `Subject: ${encodeSubject(input.fresh || /^re:/i.test(subject) ? subject : `Re: ${subject}`)}`,
    "MIME-Version: 1.0",
  ];
  if (input.from?.name && input.from.email) {
    const name = oneLine(input.from.name).replace(/["\\<>]/g, "");
    const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodeSubject(name);
    if (name) headers.push(`From: ${shown} <${oneLine(input.from.email)}>`);
  }
  if (input.replyTo) headers.push(`Reply-To: ${oneLine(input.replyTo)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${oneLine(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${oneLine(input.references)}`);

  const textPart = (type: string) =>
    [
      `Content-Type: ${type}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap64(Buffer.from(input.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64")),
    ].join("\r\n");

  if (!input.attachment) {
    return toBase64Url([...headers, textPart('text/plain; charset="UTF-8"')].join("\r\n"));
  }

  const boundary = `ops_${randomBytes(12).toString("hex")}`;
  const filename = input.attachment.name.replace(/[^\w.\- ]+/g, "_");
  const message = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    textPart('text/plain; charset="UTF-8"'),
    `--${boundary}`,
    `Content-Type: text/csv; charset="UTF-8"; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap64(Buffer.from(input.attachment.csv, "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return toBase64Url(message);
}

@Injectable()
export class GmailService {
  private readonly log = new Logger("Gmail");
  private syncing = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AutomationService) private readonly automation: AutomationService,
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
      const savedIds: string[] = [];
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
        savedIds.push(...inserted.map((row) => row.id));
      }
      if (added > 0) this.log.log(`Saved ${added} new letter(s).`);
      // Rules run in the background so a slow Claude reply never holds up the mailbox check.
      if (savedIds.length > 0) void this.automation.processNew(savedIds);
      return { added, skipped: false };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Sends the reply for one draft, as a reply in the same Gmail thread. A person clicked Send, with
   * the text they approved. The claim on `sent_at` comes first, so a double click or a second tab
   * cannot send it twice. If Gmail refuses, the claim is released so it can be tried again.
   */
  async sendRun(runId: string, subject: string, body: string) {
    const [run] = await this.db.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) throw new NotFoundException("That draft was not found.");
    if (run.status !== "done" || !run.draftBody) throw new BadRequestException("This draft is not ready to send.");
    if (run.sentAt) throw new BadRequestException("This reply was already sent.");
    const [letter] = await this.db.db.select().from(letters).where(eq(letters.id, run.letterId)).limit(1);
    if (!letter) throw new NotFoundException("The original letter was not found.");

    const to = letter.fromEmail.trim();
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to)) throw new BadRequestException("The sender's address looks invalid.");
    const text = body.trim();
    if (!text) throw new BadRequestException("The reply is empty.");

    const claimed = await this.db.db
      .update(runs)
      .set({ sentAt: new Date(), sentTo: to, draftSubject: subject.trim(), draftBody: text })
      .where(and(eq(runs.id, runId), isNull(runs.sentAt)))
      .returning({ id: runs.id });
    if (claimed.length === 0) throw new BadRequestException("This reply was already sent.");

    try {
      const token = await this.accessToken();
      // The original Message-ID lets the reply thread correctly in the sender's mail app.
      const original = await this.get<GmailMessage>(
        `users/me/messages/${letter.gmailId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
        token,
      );
      const messageId = header(original.payload, "Message-ID");
      const references = [header(original.payload, "References"), messageId].filter(Boolean).join(" ");

      const raw = buildReply({
        to,
        subject: subject.trim() || `Re: ${letter.subject}`,
        body: text,
        inReplyTo: messageId,
        references,
        attachment: run.attachmentName && run.attachmentCsv ? { name: run.attachmentName, csv: run.attachmentCsv } : null,
      });

      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw, threadId: letter.threadId }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
        if (res.status === 403) {
          throw new BadRequestException("Google did not allow sending. Connect Gmail again in Settings and allow sending mail.");
        }
        throw new BadRequestException(`Gmail could not send it (${res.status}${detail ? `: ${detail}` : ""}).`);
      }
    } catch (err) {
      await this.db.db.update(runs).set({ sentAt: null, sentTo: null }).where(eq(runs.id, runId));
      if (err instanceof HttpException) throw err;
      throw new BadRequestException("Could not reach Gmail. The reply was not sent.");
    }

    this.log.log(`Reply sent to ${to}.`);
    return { sentTo: to };
  }

  /** The address Gmail is connected as, or null when Gmail is not connected. */
  async account() {
    const [row] = await this.db.db.select().from(connectors).where(eq(connectors.kind, "gmail")).limit(1);
    return row?.secret ? (row.label ?? null) : null;
  }

  /**
   * Sends one new message (not a reply) from the connected account. Used by bulk email, which asks for a
   * token once per batch and passes it back in. Throws a plain Error with a readable reason on failure.
   */
  async sendMessage(
    message: { to: string; subject: string; body: string; fromName?: string; replyTo?: string },
    token?: string,
  ) {
    const access = token ?? (await this.accessToken());
    const account = await this.account();
    const raw = buildReply({
      to: message.to,
      subject: message.subject,
      body: message.body,
      inReplyTo: "",
      references: "",
      attachment: null,
      fresh: true,
      ...(message.fromName && account ? { from: { name: message.fromName, email: account } } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    });
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
      if (res.status === 403) throw new Error("Google did not allow sending. Connect Gmail again in Settings and allow sending mail.");
      if (res.status === 429) throw new Error("Gmail says too many messages were sent. Lower the limits in Bulk email settings.");
      throw new Error(`Gmail could not send it (${res.status}${detail ? `: ${detail}` : ""}).`);
    }
  }

  /** A fresh access token for a batch of sends. */
  async batchToken() {
    return this.accessToken();
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
