import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  broadcastRecipients,
  broadcastSettings,
  broadcastTemplates,
  broadcasts,
  clientRecords,
  letters,
  mailContacts,
  users,
  type BroadcastAudience,
} from "@opsengine/db";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { GmailService } from "./gmail.service.js";

const EVERY_MS = Number(process.env.BROADCAST_CHECK_MS ?? 60_000);
const EMAIL = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/;
const FIND_EMAIL = /[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/;
// Template text such as [HOLIDAY NAME] or [DATE] must be filled in by a person before anything goes out.
const PLACEHOLDER = /\[[A-Z][A-Z0-9 ,.'/&-]{2,}\]/;

type Contact = typeof mailContacts.$inferSelect;
type Recipient = { email: string; name: string; clientName: string };

const STARTER_TEMPLATES = [
  {
    name: "Holiday closure",
    category: "holiday",
    subject: "We will be closed for [HOLIDAY NAME]",
    body: [
      "Hello {{name}},",
      "",
      "Our warehouse will be closed on [DATE] for [HOLIDAY NAME].",
      "",
      "Orders and shipments received before then will go out as normal. Anything that arrives during the closure will be handled when we reopen on [REOPEN DATE].",
      "",
      "If something is urgent, reply to this email before the closure and we will do our best to help.",
      "",
      "Thank you for your understanding.",
    ].join("\n"),
  },
  {
    name: "Important notice",
    category: "notice",
    subject: "Important notice: [TOPIC]",
    body: [
      "Hello {{name}},",
      "",
      "We want to let you know about an important change: [WHAT IS CHANGING].",
      "",
      "It starts on [DATE]. What this means for {{client}}: [WHAT THEY NEED TO DO].",
      "",
      "If you have any questions, reply to this email and we will get back to you.",
    ].join("\n"),
  },
  {
    name: "Holiday hours",
    category: "holiday",
    subject: "Our hours around [HOLIDAY NAME]",
    body: [
      "Hello {{name}},",
      "",
      "Here are our hours around [HOLIDAY NAME]:",
      "",
      "[DATE]: [HOURS]",
      "[DATE]: [HOURS]",
      "",
      "We are back to normal hours on [REOPEN DATE].",
    ].join("\n"),
  },
] as const;

export type AudienceInput = BroadcastAudience;

function render(text: string, vars: { name: string; client: string }) {
  return text.replace(/\{\{\s*(name|client)\s*\}\}/gi, (_match, key: string) =>
    key.toLowerCase() === "name" ? vars.name || "there" : vars.client || "your team",
  );
}

function pick(contacts: Contact[], clientNames: Map<string, string>, audience: BroadcastAudience) {
  const matched = contacts.filter(
    (contact) =>
      audience.everyone ||
      audience.contactIds.includes(contact.id) ||
      contact.groups.some((group) => audience.groups.includes(group)) ||
      (contact.clientId !== null && audience.clientIds.includes(contact.clientId)),
  );
  const seen = new Set<string>();
  const people: Recipient[] = [];
  let skipped = 0;
  for (const contact of matched) {
    if (seen.has(contact.email)) continue;
    seen.add(contact.email);
    if (contact.doNotEmail) {
      skipped += 1;
      continue;
    }
    people.push({
      email: contact.email,
      name: contact.name,
      clientName: contact.clientId ? (clientNames.get(contact.clientId) ?? "") : "",
    });
  }
  return { people, skipped };
}

function cleanGroups(groups: string[]) {
  return [...new Set(groups.map((group) => group.trim().replace(/\s+/g, " ")).filter(Boolean))].slice(0, 20);
}

@Injectable()
export class BroadcastService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Bulk email");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(GmailService) private readonly gmail: GmailService,
  ) {}

  onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    this.timer = setInterval(() => {
      void this.process().catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Bulk email check failed."));
    }, EVERY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- Setup and settings ----

  /** First use: create the settings row and a few ready-made templates, once. */
  private async ensureSetup() {
    const created = await this.db.db.insert(broadcastSettings).values({ id: 1 }).onConflictDoNothing().returning();
    if (created.length > 0) {
      await this.db.db.insert(broadcastTemplates).values(STARTER_TEMPLATES.map((template) => ({ ...template })));
    }
  }

  async settings() {
    await this.ensureSetup();
    const [row] = await this.db.db.select().from(broadcastSettings).limit(1);
    return {
      senderName: row?.senderName ?? "",
      replyTo: row?.replyTo ?? "",
      signature: row?.signature ?? "",
      dailyLimit: row?.dailyLimit ?? 400,
      perMinute: row?.perMinute ?? 30,
      gmailAccount: await this.gmail.account(),
    };
  }

  async saveSettings(input: { senderName: string; replyTo: string; signature: string; dailyLimit: number; perMinute: number }) {
    await this.ensureSetup();
    if (input.replyTo && !EMAIL.test(input.replyTo)) throw new BadRequestException("The reply-to address looks invalid.");
    await this.db.db
      .update(broadcastSettings)
      .set({
        senderName: input.senderName.trim(),
        replyTo: input.replyTo.trim(),
        signature: input.signature.trim(),
        dailyLimit: Math.min(2000, Math.max(1, Math.round(input.dailyLimit))),
        perMinute: Math.min(120, Math.max(1, Math.round(input.perMinute))),
        updatedAt: new Date(),
      })
      .where(eq(broadcastSettings.id, 1));
    return this.settings();
  }

  async templates() {
    await this.ensureSetup();
    return this.db.db.select().from(broadcastTemplates).orderBy(asc(broadcastTemplates.createdAt), asc(broadcastTemplates.name));
  }

  async addTemplate(input: { name: string; category: string; subject: string; body: string }) {
    await this.ensureSetup();
    await this.db.db.insert(broadcastTemplates).values(input);
    return this.templates();
  }

  async removeTemplate(id: string) {
    await this.db.db.delete(broadcastTemplates).where(eq(broadcastTemplates.id, id));
    return this.templates();
  }

  // ---- Contacts ----

  private async clientNames() {
    const rows = await this.db.db.select({ id: clientRecords.id, name: clientRecords.name }).from(clientRecords);
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async options() {
    const [clients, contacts] = await Promise.all([
      this.db.db.select({ id: clientRecords.id, name: clientRecords.name }).from(clientRecords).orderBy(asc(clientRecords.name)),
      this.db.db.select({ groups: mailContacts.groups }).from(mailContacts),
    ]);
    const groups = [...new Set(contacts.flatMap((row) => row.groups))].sort((a, b) => a.localeCompare(b));
    return { clients, groups };
  }

  async contacts() {
    const [rows, names] = await Promise.all([
      this.db.db.select().from(mailContacts).orderBy(asc(mailContacts.name), asc(mailContacts.email)),
      this.clientNames(),
    ]);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      clientId: row.clientId,
      clientName: row.clientId ? (names.get(row.clientId) ?? null) : null,
      groups: row.groups,
      doNotEmail: row.doNotEmail,
    }));
  }

  async addContact(input: { email: string; name: string; clientId?: string | null; groups: string[] }) {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw new BadRequestException("That email address looks invalid.");
    const inserted = await this.db.db
      .insert(mailContacts)
      .values({ email, name: input.name.trim(), clientId: input.clientId ?? null, groups: cleanGroups(input.groups) })
      .onConflictDoNothing()
      .returning({ id: mailContacts.id });
    if (inserted.length === 0) throw new ConflictException("That address is already in the list.");
    return this.contacts();
  }

  async updateContact(
    id: string,
    input: { name: string; clientId?: string | null; groups: string[]; doNotEmail: boolean },
  ) {
    const updated = await this.db.db
      .update(mailContacts)
      .set({
        name: input.name.trim(),
        clientId: input.clientId ?? null,
        groups: cleanGroups(input.groups),
        doNotEmail: input.doNotEmail,
      })
      .where(eq(mailContacts.id, id))
      .returning({ id: mailContacts.id });
    if (updated.length === 0) throw new NotFoundException("That contact was not found.");
    return this.contacts();
  }

  async removeContact(id: string) {
    await this.db.db.delete(mailContacts).where(eq(mailContacts.id, id));
    return this.contacts();
  }

  async importContacts(input: { source: "staff" | "letters" | "paste"; text?: string; group?: string; clientId?: string | null }) {
    const group = input.group?.trim() ?? "";
    let found: { email: string; name: string; clientId: string | null; groups: string[] }[] = [];

    if (input.source === "staff") {
      const rows = await this.db.db.select({ email: users.email, name: users.name }).from(users);
      found = rows.map((row) => ({ email: row.email, name: row.name, clientId: null, groups: ["Staff"] }));
    } else if (input.source === "letters") {
      const account = (await this.gmail.account())?.toLowerCase();
      const rows = await this.db.db
        .select({ email: letters.fromEmail, name: letters.fromName, clientId: letters.clientId })
        .from(letters)
        .orderBy(desc(letters.receivedAt));
      const seen = new Set<string>();
      for (const row of rows) {
        const email = row.email.trim().toLowerCase();
        if (seen.has(email) || email === account || /(^|[._-])(no-?reply|donotreply|mailer-daemon|postmaster)/.test(email)) continue;
        seen.add(email);
        found.push({ email, name: row.name ?? "", clientId: row.clientId, groups: ["Customers"] });
      }
    } else {
      for (const line of (input.text ?? "").split(/\r?\n/)) {
        const match = FIND_EMAIL.exec(line);
        if (!match) continue;
        const name = line
          .replace(match[0], " ")
          .replace(/[<>"';]/g, " ")
          .replace(/^[\s,]+|[\s,]+$/g, "")
          .replace(/\s+/g, " ");
        found.push({ email: match[0], name, clientId: input.clientId ?? null, groups: [] });
      }
    }

    const rows = found
      .map((row) => ({
        email: row.email.trim().toLowerCase(),
        name: row.name.trim(),
        clientId: row.clientId,
        groups: cleanGroups([...row.groups, ...(group ? [group] : [])]),
      }))
      .filter((row) => EMAIL.test(row.email));
    if (rows.length === 0) return { added: 0, skipped: 0, contacts: await this.contacts() };

    const added = await this.db.db.insert(mailContacts).values(rows).onConflictDoNothing().returning({ id: mailContacts.id });
    // An address already on the list keeps its settings, but still joins the group you picked.
    if (group) {
      const emails = rows.map((row) => row.email);
      const existing = await this.db.db.select().from(mailContacts).where(inArray(mailContacts.email, emails));
      for (const row of existing) {
        if (!row.groups.includes(group)) {
          await this.db.db.update(mailContacts).set({ groups: cleanGroups([...row.groups, group]) }).where(eq(mailContacts.id, row.id));
        }
      }
    }
    return { added: added.length, skipped: rows.length - added.length, contacts: await this.contacts() };
  }

  // ---- Campaigns ----

  async preview(audience: BroadcastAudience) {
    const [contacts, names] = await Promise.all([this.db.db.select().from(mailContacts), this.clientNames()]);
    const { people, skipped } = pick(contacts, names, audience);
    return { count: people.length, skipped, sample: people.slice(0, 5).map((p) => p.name || p.email) };
  }

  async list() {
    const [rows, counts, contacts, names] = await Promise.all([
      this.db.db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).limit(100),
      this.db.db
        .select({ id: broadcastRecipients.broadcastId, status: broadcastRecipients.status, n: sql<number>`count(*)::int` })
        .from(broadcastRecipients)
        .groupBy(broadcastRecipients.broadcastId, broadcastRecipients.status),
      this.db.db.select().from(mailContacts),
      this.clientNames(),
    ]);
    return rows.map((row) => {
      const mine = counts.filter((item) => item.id === row.id);
      const of = (status: string) => mine.find((item) => item.status === status)?.n ?? 0;
      const sent = of("sent");
      const failed = of("failed");
      const pending = of("pending");
      const total = sent + failed + pending;
      return {
        id: row.id,
        title: row.title,
        category: row.category,
        subject: row.subject,
        body: row.body,
        audience: row.audience,
        status: row.status,
        scheduledAt: row.scheduledAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        note: row.note,
        createdAt: row.createdAt,
        total: total > 0 ? total : row.status === "draft" || row.status === "scheduled" ? pick(contacts, names, row.audience).people.length : 0,
        sent,
        failed,
        pending,
      };
    });
  }

  async recipients(id: string) {
    const [row] = await this.db.db.select({ id: broadcasts.id }).from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
    if (!row) throw new NotFoundException("That campaign was not found.");
    return this.db.db
      .select()
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, id))
      .orderBy(asc(broadcastRecipients.status), asc(broadcastRecipients.email))
      .limit(2000);
  }

  async save(
    userId: string,
    id: string | null,
    input: { title: string; category: string; subject: string; body: string; audience: BroadcastAudience },
  ) {
    const values = {
      title: input.title.trim(),
      category: input.category,
      subject: input.subject.trim(),
      body: input.body.trim(),
      audience: {
        everyone: input.audience.everyone,
        groups: cleanGroups(input.audience.groups),
        clientIds: input.audience.clientIds,
        contactIds: input.audience.contactIds,
      },
      updatedAt: new Date(),
    };
    if (!id) {
      const [created] = await this.db.db.insert(broadcasts).values({ ...values, createdBy: userId }).returning({ id: broadcasts.id });
      if (!created) throw new ConflictException("Could not save the campaign.");
      return { id: created.id };
    }
    const updated = await this.db.db
      .update(broadcasts)
      .set(values)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "draft")))
      .returning({ id: broadcasts.id });
    if (updated.length === 0) throw new ConflictException("Only a draft can be edited. Take it off the schedule first.");
    return { id };
  }

  async remove(id: string) {
    const gone = await this.db.db
      .delete(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "draft")))
      .returning({ id: broadcasts.id });
    if (gone.length === 0) throw new ConflictException("Only a draft can be deleted. Sent campaigns stay as a record.");
    return { ok: true };
  }

  /** Schedules a draft for a time, or for right now. The sender loop picks it up. */
  async schedule(id: string, at: Date | null) {
    const [row] = await this.db.db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
    if (!row) throw new NotFoundException("That campaign was not found.");
    if (row.status !== "draft") throw new ConflictException("This campaign is already scheduled or sent.");
    if (PLACEHOLDER.test(row.subject) || PLACEHOLDER.test(row.body)) {
      throw new BadRequestException("Replace the [BRACKETED] parts of the subject and message first.");
    }
    if (!row.subject.trim() || !row.body.trim()) throw new BadRequestException("Add a subject and a message first.");
    if (at && at.getTime() < Date.now() - 30_000) throw new BadRequestException("Choose a time in the future.");
    if (!(await this.gmail.account())) throw new BadRequestException("Connect Gmail in Settings first.");
    const { count } = await this.preview(row.audience);
    if (count === 0) throw new BadRequestException("Nobody is selected. Pick who should get this.");

    const when = at ?? new Date();
    const claimed = await this.db.db
      .update(broadcasts)
      .set({ status: "scheduled", scheduledAt: when, note: null, updatedAt: new Date() })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "draft")))
      .returning({ id: broadcasts.id });
    if (claimed.length === 0) throw new ConflictException("This campaign is already scheduled or sent.");
    if (!at) void this.process().catch((err: unknown) => this.log.warn(err instanceof Error ? err.message : "Send failed."));
    return {
      count,
      message: at ? `Scheduled for ${count} ${count === 1 ? "person" : "people"}.` : `Sending to ${count} ${count === 1 ? "person" : "people"} now.`,
    };
  }

  async unschedule(id: string) {
    const back = await this.db.db
      .update(broadcasts)
      .set({ status: "draft", scheduledAt: null, updatedAt: new Date() })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "scheduled")))
      .returning({ id: broadcasts.id });
    if (back.length === 0) throw new ConflictException("It already started sending, or it was not scheduled.");
    return { ok: true };
  }

  /** Stops a campaign that is part-way through. People already emailed stay emailed. */
  async stop(id: string) {
    const stopped = await this.db.db
      .update(broadcasts)
      .set({ status: "failed", finishedAt: new Date(), note: "Stopped by a person before everyone was emailed.", updatedAt: new Date() })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "sending")))
      .returning({ id: broadcasts.id });
    if (stopped.length === 0) throw new ConflictException("That campaign is not sending.");
    return { ok: true };
  }

  /** Sends the text to the connected Gmail address only, so you can see how it looks. */
  async test(input: { subject: string; body: string }) {
    const account = await this.gmail.account();
    if (!account) throw new BadRequestException("Connect Gmail in Settings first.");
    const settings = await this.settings();
    try {
      await this.gmail.sendMessage({
        to: account,
        subject: `[TEST] ${render(input.subject, { name: "Sample Name", client: "Sample Client" })}`,
        body: this.compose(input.body, settings.signature, { name: "Sample Name", client: "Sample Client" }),
        fromName: settings.senderName,
        replyTo: settings.replyTo,
      });
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Could not send the test.");
    }
    return { sentTo: account };
  }

  private compose(body: string, signature: string, vars: { name: string; client: string }) {
    const text = render(body, vars).trim();
    return signature ? `${text}\n\n${signature}` : text;
  }

  // ---- Sending ----

  /**
   * Called every minute, and right after "Send now". Starts campaigns that are due, then sends a
   * limited batch so the daily and per-minute limits are respected. Safe to call at any time.
   */
  async process() {
    if (this.running) return { sent: 0 };
    this.running = true;
    let sent = 0;
    try {
      const orm = this.db.db;
      const due = await orm
        .update(broadcasts)
        .set({ status: "sending", startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(broadcasts.status, "scheduled"), lte(broadcasts.scheduledAt, new Date())))
        .returning();
      for (const row of due) await this.snapshot(row);

      const active = await orm.select().from(broadcasts).where(eq(broadcasts.status, "sending")).orderBy(asc(broadcasts.startedAt));
      if (active.length === 0) return { sent: 0 };

      const settings = await this.settings();
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const [today] = await orm
        .select({ n: sql<number>`count(*)::int` })
        .from(broadcastRecipients)
        .where(and(eq(broadcastRecipients.status, "sent"), gte(broadcastRecipients.sentAt, startOfDay)));
      let budget = Math.min(settings.perMinute, settings.dailyLimit - (today?.n ?? 0));
      if (budget <= 0) {
        await orm
          .update(broadcasts)
          .set({ note: "The daily limit was reached. It carries on tomorrow." })
          .where(eq(broadcasts.status, "sending"));
        return { sent: 0 };
      }

      let token: string;
      try {
        token = await this.gmail.batchToken();
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Gmail did not accept the sign-in.";
        await orm.update(broadcasts).set({ note: `Paused: ${reason}` }).where(eq(broadcasts.status, "sending"));
        return { sent: 0 };
      }

      for (const row of active) {
        const batch = await orm
          .select()
          .from(broadcastRecipients)
          .where(and(eq(broadcastRecipients.broadcastId, row.id), eq(broadcastRecipients.status, "pending")))
          .orderBy(asc(broadcastRecipients.email))
          .limit(budget);
        let blocked: string | null = null;
        for (const person of batch) {
          try {
            await this.gmail.sendMessage(
              {
                to: person.email,
                subject: render(row.subject, { name: person.name, client: person.clientName }),
                body: this.compose(row.body, settings.signature, { name: person.name, client: person.clientName }),
                fromName: settings.senderName,
                replyTo: settings.replyTo,
              },
              token,
            );
            await orm
              .update(broadcastRecipients)
              .set({ status: "sent", sentAt: new Date(), error: null })
              .where(eq(broadcastRecipients.id, person.id));
            sent += 1;
            budget -= 1;
          } catch (err) {
            const reason = err instanceof Error ? err.message : "Could not send.";
            // A refusal that affects everyone stops the batch; the rest stay pending.
            if (/did not allow sending|too many messages/.test(reason)) {
              blocked = reason;
              break;
            }
            await orm
              .update(broadcastRecipients)
              .set({ status: "failed", error: reason.slice(0, 300) })
              .where(eq(broadcastRecipients.id, person.id));
            budget -= 1;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (blocked) {
          await orm.update(broadcasts).set({ note: `Paused: ${blocked}` }).where(eq(broadcasts.id, row.id));
          break;
        }
        await this.finishIfDone(row.id);
        if (budget <= 0) break;
      }
      if (sent > 0) this.log.log(`Sent ${sent} bulk email(s).`);
      return { sent };
    } finally {
      this.running = false;
    }
  }

  /** Writes the list of people for a campaign that just started. From here on the list is fixed. */
  private async snapshot(row: typeof broadcasts.$inferSelect) {
    const [contacts, names] = await Promise.all([this.db.db.select().from(mailContacts), this.clientNames()]);
    const { people } = pick(contacts, names, row.audience);
    if (people.length === 0) {
      await this.db.db
        .update(broadcasts)
        .set({ status: "failed", finishedAt: new Date(), note: "Nobody was left to send to.", updatedAt: new Date() })
        .where(eq(broadcasts.id, row.id));
      return;
    }
    await this.db.db
      .insert(broadcastRecipients)
      .values(people.map((person) => ({ broadcastId: row.id, email: person.email, name: person.name, clientName: person.clientName })))
      .onConflictDoNothing();
  }

  private async finishIfDone(id: string) {
    const orm = this.db.db;
    const rows = await orm
      .select({ status: broadcastRecipients.status, n: sql<number>`count(*)::int` })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, id))
      .groupBy(broadcastRecipients.status);
    const of = (status: string) => rows.find((row) => row.status === status)?.n ?? 0;
    if (of("pending") > 0) return;
    const failed = of("failed");
    await orm
      .update(broadcasts)
      .set({
        status: of("sent") > 0 ? "sent" : "failed",
        finishedAt: new Date(),
        note: failed > 0 ? `${failed} could not be sent. Open the campaign to see why.` : null,
        updatedAt: new Date(),
      })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, "sending")));
  }
}
