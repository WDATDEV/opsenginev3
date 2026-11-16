import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  chatMessages,
  chatThreads,
  clientRecords,
  connectors,
  employees,
  jobs,
  type ChatJobChange,
  type ChatLookup,
} from "@opsengine/db";
import { can, ForbiddenError, type Principal } from "@opsengine/kernel";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { ask, modelFor, type Block, type ClaudeTool, type Message } from "../mail/anthropic.js";
import { JobsService } from "./jobs.service.js";
import {
  JOB_CHAT_KIND,
  jobChatGate,
  parseAssignPeople,
  parseCreateJob,
  type JobCard,
  type OpsClient,
  type OpsJob,
  type OpsPerson,
} from "./jobs-chat.js";

type Thread = typeof chatThreads.$inferSelect;
type ToolUse = Extract<Block, { type: "tool_use" }>;

const MAX_TURNS = 8;
const HISTORY = 24;
const STUCK_MS = 6 * 60_000;

const RULES = `You are the Ops Engine assistant for Time tracking jobs. You help open jobs and assign people on the floor.

Rules:
- Use only the Time tracking list tools. Never invent a client, person, job, or id.
- To open a job, look up the client (and people if they named a crew), then call propose_create_job. That only fills a card. Tell them to press Confirm on the card. Never claim the job exists until they confirm.
- To assign people to an existing job, look the job and people up, then call propose_assign_people. Same card and Confirm rule.
- If this chat is limited to one client, do not use another client.
- Answer in plain text, short and clear. No markdown tables.
- You cannot change Warehance from here.`;

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class JobsChatService {
  private readonly log = new Logger("JobsChat");

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  async ready() {
    const rows = await this.db.db.select().from(connectors).where(eq(connectors.kind, "anthropic")).limit(1);
    return { claude: Boolean(rows[0]?.secret || process.env.ANTHROPIC_API_KEY) };
  }

  async get(principal: Principal, scopedClientId?: string | null) {
    const thread = await this.thread(principal.id);
    const stale = new Date(Date.now() - STUCK_MS);
    const waiting = await this.db.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.threadId, thread.id), eq(chatMessages.status, "working")));
    for (const row of waiting.filter((item) => item.createdAt < stale)) {
      await this.db.db
        .update(chatMessages)
        .set({ status: "failed", error: "This took too long and was stopped. Ask again." })
        .where(and(eq(chatMessages.id, row.id), eq(chatMessages.status, "working")));
    }
    const messages = await this.db.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt));
    return {
      thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt },
      scopedClientId: scopedClientId ?? null,
      messages: messages.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        status: row.status,
        error: row.error,
        lookups: row.lookups,
        jobChange: row.jobChange,
        createdAt: row.createdAt,
      })),
    };
  }

  async ask(principal: Principal, text: string, scopedClientId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const ready = await this.ready();
    if (!ready.claude) throw new BadRequestException("Add the Claude API key in Settings first.");
    const thread = await this.thread(principal.id);
    const busy = await this.db.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.threadId, thread.id), eq(chatMessages.status, "working")))
      .limit(1);
    if (busy.length > 0) throw new BadRequestException("Wait for the answer to the last question first.");
    await this.db.db.insert(chatMessages).values({ threadId: thread.id, role: "user", content: text.trim() });
    const [answer] = await this.db.db
      .insert(chatMessages)
      .values({ threadId: thread.id, role: "assistant", status: "working" })
      .returning();
    await this.db.db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));
    void this.runTurn(principal, thread, answer!.id, scopedClientId ?? null).catch((err) =>
      this.log.error(`Jobs chat turn crashed: ${String(err)}`),
    );
    return this.get(principal, scopedClientId);
  }

  async confirm(principal: Principal, messageId: string) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const thread = await this.thread(principal.id);
    const [row] = await this.db.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.threadId, thread.id)))
      .limit(1);
    if (!row) throw new NotFoundException("That message was not found.");
    const card = row.jobChange;
    const blocked = jobChatGate({
      canManage: true,
      actorId: principal.id,
      threadOwnerId: thread.ownerId,
      status: card?.status,
      expiresAt: card?.expiresAt,
      now: Date.now(),
    });
    if (blocked) throw new BadRequestException(blocked);
    const applying: ChatJobChange = { ...card!, status: "applying", error: null };
    const claimed = await this.db.db
      .update(chatMessages)
      .set({ jobChange: applying })
      .where(and(eq(chatMessages.id, row.id), sql`${chatMessages.jobChange}->>'status' = 'proposed'`))
      .returning({ id: chatMessages.id });
    if (!claimed[0]) throw new BadRequestException("Someone already confirmed that card.");
    try {
      const result = await this.applyCard(principal, applying);
      const done: ChatJobChange = { ...applying, status: "applied", result, error: null };
      await this.db.db.update(chatMessages).set({ jobChange: done }).where(eq(chatMessages.id, row.id));
    } catch (err) {
      const message = explain(err);
      const failed: ChatJobChange = { ...applying, status: "rejected", error: message };
      await this.db.db.update(chatMessages).set({ jobChange: failed }).where(eq(chatMessages.id, row.id));
      throw new BadRequestException(message);
    }
    return this.get(principal);
  }

  private async thread(ownerId: string) {
    const [existing] = await this.db.db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.kind, JOB_CHAT_KIND)))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(1);
    if (existing) return existing;
    const [created] = await this.db.db
      .insert(chatThreads)
      .values({ ownerId, title: "Jobs", kind: JOB_CHAT_KIND, model: "haiku" })
      .returning();
    if (!created) throw new BadRequestException("Could not open the jobs chat.");
    return created;
  }

  private async runTurn(principal: Principal, thread: Thread, messageId: string, scopedClientId: string | null) {
    const key = (await this.db.db.select().from(connectors).where(eq(connectors.kind, "anthropic")).limit(1))[0]?.secret || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Add the Claude API key in Settings first.");
    const catalog = await this.catalog(principal);
    const history = await this.db.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt));
    const prior = history.filter((row) => row.id !== messageId).slice(-HISTORY);
    const messages: Message[] = prior.map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content || "(no text)",
    }));
    const scope = scopedClientId ? catalog.clients.find((client) => client.id === scopedClientId) : null;
    const system = [
      RULES,
      scope ? `This jobs page is limited to ${scope.name}. Only use that client.` : "This jobs page can see every Time tracking client.",
    ].join("\n");
    const tools = this.tools();
    let lookups: ChatLookup[] = [];
    let jobChange: ChatJobChange | null = null;
    let reply = await ask(key, { model: modelFor("haiku"), system, messages, tools });
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const uses = reply.content.filter((block): block is ToolUse => block.type === "tool_use");
      const text = reply.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (uses.length === 0) {
        await this.db.db
          .update(chatMessages)
          .set({ content: text || "Ask me to open a job or assign people.", status: "done", error: null, lookups, jobChange })
          .where(eq(chatMessages.id, messageId));
        return;
      }
      const results: Block[] = [];
      for (const use of uses) {
        const [content, isError] = await this.useTool(use, catalog, scopedClientId, (card) => {
          jobChange = card;
        });
        lookups = [...lookups, { tool: use.name, summary: clip(`${use.name}: ${isError ? content : "ok"}`, 120) }];
        await this.db.db.update(chatMessages).set({ lookups, jobChange }).where(eq(chatMessages.id, messageId));
        results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: isError || undefined });
      }
      messages.push({ role: "assistant", content: reply.content });
      messages.push({ role: "user", content: results });
      reply = await ask(key, { model: modelFor("haiku"), system, messages, tools });
    }
    await this.db.db
      .update(chatMessages)
      .set({ content: "That took too many steps. Ask again with the client, job reference, and people named.", status: "done", lookups, jobChange })
      .where(eq(chatMessages.id, messageId));
  }

  private tools(): ClaudeTool[] {
    return [
      {
        name: "list_ops_clients",
        description: "List Time tracking clients that jobs can be opened for.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "list_ops_people",
        description: "List people who can be assigned to a job. Optionally filter by client_name or query.",
        input_schema: {
          type: "object",
          properties: { client_name: { type: "string" }, query: { type: "string" } },
        },
      },
      {
        name: "list_ops_jobs",
        description: "List open Time tracking jobs. Optionally filter by client_name or query.",
        input_schema: {
          type: "object",
          properties: { client_name: { type: "string" }, query: { type: "string" } },
        },
      },
      {
        name: "propose_create_job",
        description: "Prepare a card to open a job. Does not save the job until the owner confirms.",
        input_schema: {
          type: "object",
          properties: {
            client_name: { type: "string" },
            reference: { type: "string" },
            title: { type: "string" },
            bill_basis: { type: "string" },
            people: { type: "array", items: { type: "string" } },
          },
          required: ["client_name", "reference", "title"],
        },
      },
      {
        name: "propose_assign_people",
        description: "Prepare a card to assign people to an open job. Does not assign until Confirm.",
        input_schema: {
          type: "object",
          properties: {
            job_reference: { type: "string" },
            people: { type: "array", items: { type: "string" } },
          },
          required: ["job_reference", "people"],
        },
      },
    ];
  }

  private async useTool(
    use: ToolUse,
    catalog: { clients: OpsClient[]; people: OpsPerson[]; jobs: OpsJob[] },
    scopedClientId: string | null,
    save: (card: JobCard) => void,
  ): Promise<[string, boolean]> {
    const args = asRecord(use.input);
    try {
      if (use.name === "list_ops_clients") {
        const rows = catalog.clients.filter((client) => !scopedClientId || client.id === scopedClientId);
        return [JSON.stringify({ records: rows.map((client) => ({ name: client.name })) }), false];
      }
      if (use.name === "list_ops_people") {
        const query = String(args.query ?? "").trim().toLowerCase();
        const clientName = String(args.client_name ?? "").trim().toLowerCase();
        const client = clientName ? catalog.clients.find((item) => item.name.trim().toLowerCase() === clientName) : null;
        const rows = catalog.people.filter((person) => {
          if (scopedClientId && person.clientId && person.clientId !== scopedClientId) return false;
          if (client && person.clientId && person.clientId !== client.id) return false;
          if (query && !person.name.toLowerCase().includes(query)) return false;
          return true;
        });
        return [
          JSON.stringify({
            records: rows.slice(0, 80).map((person) => ({
              name: person.name,
              client: catalog.clients.find((item) => item.id === person.clientId)?.name ?? null,
            })),
          }),
          false,
        ];
      }
      if (use.name === "list_ops_jobs") {
        const query = String(args.query ?? "").trim().toLowerCase();
        const clientName = String(args.client_name ?? "").trim().toLowerCase();
        const client = clientName ? catalog.clients.find((item) => item.name.trim().toLowerCase() === clientName) : null;
        const rows = catalog.jobs.filter((job) => {
          if (scopedClientId && job.clientId !== scopedClientId) return false;
          if (client && job.clientId !== client.id) return false;
          if (query && !`${job.reference} ${job.title}`.toLowerCase().includes(query)) return false;
          return job.status !== "done";
        });
        return [
          JSON.stringify({
            records: rows.slice(0, 80).map((job) => ({
              reference: job.reference,
              title: job.title,
              client: catalog.clients.find((item) => item.id === job.clientId)?.name ?? null,
            })),
          }),
          false,
        ];
      }
      if (use.name === "propose_create_job") {
        const parsed = parseCreateJob(args, { ...catalog, now: Date.now(), scopedClientId });
        if (!parsed.ok) return [parsed.error, true];
        save(parsed.card);
        return [JSON.stringify({ ok: true, summary: parsed.card.summary }), false];
      }
      if (use.name === "propose_assign_people") {
        const parsed = parseAssignPeople(args, { ...catalog, now: Date.now(), scopedClientId });
        if (!parsed.ok) return [parsed.error, true];
        save(parsed.card);
        return [JSON.stringify({ ok: true, summary: parsed.card.summary }), false];
      }
      return ["That tool is not allowed in jobs chat.", true];
    } catch (err) {
      return [err instanceof Error ? err.message : "Could not run that lookup.", true];
    }
  }

  private async catalog(principal: Principal) {
    const board = await this.jobs.list(principal);
    const clients: OpsClient[] = (await this.db.db.select().from(clientRecords)).map((client) => ({
      id: client.id,
      name: client.name,
      hidden: client.hidden,
      enabledServices: client.enabledServices,
    }));
    const visible = new Set(board.clients.map((client) => client.id));
    const people: OpsPerson[] = (await this.db.db.select().from(employees)).map((person) => ({
      id: person.id,
      name: person.name,
      clientId: person.clientId,
      active: person.active,
    }));
    const jobRows: OpsJob[] = (await this.db.db.select().from(jobs)).map((job) => ({
      id: job.id,
      reference: job.reference,
      title: job.title,
      clientId: job.clientId,
      status: job.status,
    }));
    return {
      clients: clients.filter((client) => !client.hidden && visible.has(client.id)),
      people: people.filter((person) => person.active !== false && board.people.some((item) => item.id === person.id)),
      jobs: jobRows.filter((job) => visible.has(job.clientId)),
    };
  }

  private async applyCard(principal: Principal, card: JobCard) {
    const notes: string[] = [];
    let jobId = card.jobId;
    if (card.kind === "create_job") {
      const created = await this.jobs.create(principal, {
        clientId: card.clientId,
        reference: card.jobReference,
        title: card.title,
        billBasis: card.billBasis ?? "mixed",
      });
      jobId = created.id;
      notes.push(created.message);
    }
    if (!jobId) throw new Error("That job is not on file.");
    for (const person of card.people) {
      const assigned = await this.jobs.assign(principal, jobId, person.employeeId);
      notes.push(assigned.message);
    }
    if (notes.length === 0) return `${card.jobReference} is assigned.`;
    return notes.join(" ");
  }
}

function explain(err: unknown) {
  if (err && typeof err === "object" && "getResponse" in err && typeof err.getResponse === "function") {
    const body = (err as { getResponse: () => unknown }).getResponse();
    if (typeof body === "string" && body.trim()) return body;
    if (body && typeof body === "object" && "message" in body) {
      const text = (body as { message: unknown }).message;
      if (typeof text === "string" && text.trim()) return text;
      if (Array.isArray(text)) return text.map(String).join(" ");
    }
  }
  return err instanceof Error ? err.message : "Could not save that job.";
}
