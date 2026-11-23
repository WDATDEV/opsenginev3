import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  activityTypes,
  chatMessages,
  chatThreads,
  clientRecords,
  connectors,
  employees,
  jobs,
  type ChatJobChange,
  type ChatLookup,
} from "@opsengine/db";
import { assertClientVisible, can, ForbiddenError, type Principal } from "@opsengine/kernel";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DbService } from "../db.service.js";
import { isCancelled, STOPPED, throwIfAborted } from "../mail/abort.js";
import { ask, modelFor, type Block, type ClaudeTool, type Message } from "../mail/anthropic.js";
import { JobsService } from "./jobs.service.js";
import {
  historyContent,
  jobChatGate,
  jobChatKind,
  parseAddTasks,
  parseAssignPeople,
  parseCreateJob,
  parseEditJob,
  recheckCard,
  requestText,
  reviseCard,
  sessionSummary,
  sessionTitle,
  trimHistory,
  type CardEdit,
  type JobCard,
  type OpsClient,
  type OpsJob,
  type OpsPerson,
  type OpsWork,
} from "./jobs-chat.js";

type Thread = typeof chatThreads.$inferSelect;
type ToolUse = Extract<Block, { type: "tool_use" }>;

const MAX_TURNS = 8;
const HISTORY = 24;
const STUCK_MS = 6 * 60_000;

const RULES = `You are the Ops Engine assistant for Time tracking jobs. You help open jobs, create their tasks, change open jobs, and assign people on the floor.

Rules:
- Use only the Time tracking list tools. Never invent a client, person, job, reference, or id.
- Before propose_create_job, call list_ops_clients. If they named people, call list_ops_people for that client. Copy client_name and people strings exactly from those records. If a name is missing or several people match, ask — do not guess.
- Before propose_assign_people, call list_ops_jobs and list_ops_people. Copy job_reference and people exactly from those records.
- Reference: pass it only if the person typed one. Otherwise leave it out and the app numbers the job.
- Title: a short description in the person's own words, such as "Unload 20 pallets". If they did not say what the job is for, ask.
- Bill by: pass bill_basis only if they said how to bill, such as hourly or per pallet. A count like "20 pallets" describes the work, not the billing.
- People: add only people they named. Never add someone because they worked with this client before.
- To change a job that is already open, call list_ops_jobs, then propose_edit_job. Pass only what they asked to change. Use it to rename, change the reference or billing, or add and remove people in one card. If they say "that job", use the job in the latest card. If it could be more than one job, ask.
- If a card is still waiting for Confirm and they want it changed, propose the same kind of card again with the change. If that job is already saved, use propose_edit_job.
- A job cannot be moved to another client, and closed jobs cannot be changed. Say so.
- If they ask for several jobs, call propose_create_job once per job in the same reply. Each job gets its own card.
- Workers only see tasks on the floor phone, so every new job needs tasks. In propose_create_job, pass tasks with a short title in their words, the work_type, and who does it. "Unload 20 pallets and pack 50 orders, Sam unloads, Ada packs" is two tasks. If one task names two people, list both and each gets their own copy.
- work_type must be a name from the Work types list. If the words do not make the kind of work clear, ask. Never guess it.
- To add work to a job that already exists, call list_ops_jobs, then propose_add_tasks with every new task in one call. Use it for "add a task", "give Sam packing on NEW-1001", or "Sam should pack on that job".
- Use propose_assign_people only when they want someone on the job with no specific work. The app gives that person a task from the job title.
- A card stores client, reference, title, bill by, people, and tasks. Put anything else they asked for, such as dates, start times, quantities that are not in a title, docks, or carriers, in not_saved in their words, and tell them it was not saved.
- If a tool returns an error, fix it from the lists or ask the person. Do not work around it.
- [App note: ...] lines in the history are written by the app and show each card's real status. Do not repeat them. "applied" means saved. "proposed" means it is waiting for Confirm.
- A card only fills a form. Tell them to press Confirm. Never claim the job was created or people were assigned until they confirm.
- If this chat is limited to one client, do not use another client.
- Answer in plain text, short and clear. No markdown tables.
- You cannot change Warehance from here.`;

const TASKS_SCHEMA = {
  type: "array",
  description: "The work on this job. One entry per task.",
  items: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short task title in the person's words." },
      work_type: { type: "string", description: "Exact name from the Work types list." },
      people: { type: "array", items: { type: "string" }, description: "Who does this task, copied from list_ops_people." },
    },
    required: ["title", "work_type"],
  },
};

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class JobsChatService {
  private readonly log = new Logger("JobsChat");
  private readonly turns = new Map<string, AbortController>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  async ready() {
    const rows = await this.db.db.select().from(connectors).where(eq(connectors.kind, "anthropic")).limit(1);
    return { claude: Boolean(rows[0]?.secret || process.env.ANTHROPIC_API_KEY) };
  }

  async get(principal: Principal, scopedClientId?: string | null, threadId?: string | null) {
    const thread = await this.thread(principal, scopedClientId, threadId);
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
      thread: {
        id: thread.id,
        title: sessionTitle(thread.title, messages.find((row) => row.role === "user")?.content),
        updatedAt: thread.updatedAt,
        hidden: Boolean(thread.hiddenAt),
      },
      sessions: await this.sessions(principal, scopedClientId),
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

  private async sessions(principal: Principal, scopedClientId?: string | null) {
    const threads = await this.db.db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerId, principal.id), eq(chatThreads.kind, jobChatKind(scopedClientId))))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(100);
    if (threads.length === 0) return [];
    const rows = await this.db.db
      .select({
        threadId: chatMessages.threadId,
        role: chatMessages.role,
        content: chatMessages.content,
        status: chatMessages.status,
        createdAt: chatMessages.createdAt,
        jobChange: chatMessages.jobChange,
      })
      .from(chatMessages)
      .where(inArray(chatMessages.threadId, threads.map((thread) => thread.id)))
      .orderBy(asc(chatMessages.createdAt));
    const now = Date.now();
    return threads.map((thread) => sessionSummary(thread, rows.filter((row) => row.threadId === thread.id), now, STUCK_MS));
  }

  /** Opens a fresh chat. An unused one is reused, so pressing New chat twice does not pile up empty chats. */
  async newSession(principal: Principal, scopedClientId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    if (scopedClientId) assertClientVisible(principal, scopedClientId);
    const kind = jobChatKind(scopedClientId);
    const visible = await this.db.db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerId, principal.id), eq(chatThreads.kind, kind), isNull(chatThreads.hiddenAt)));
    if (visible.length > 0) {
      const used = await this.db.db
        .selectDistinct({ threadId: chatMessages.threadId })
        .from(chatMessages)
        .where(inArray(chatMessages.threadId, visible.map((row) => row.id)));
      const empty = visible.find((row) => !used.some((item) => item.threadId === row.id));
      if (empty) {
        await this.db.db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, empty.id));
        return this.get(principal, scopedClientId, empty.id);
      }
    }
    const [created] = await this.db.db
      .insert(chatThreads)
      .values({ ownerId: principal.id, title: "New chat", kind, model: "haiku" })
      .returning();
    if (!created) throw new BadRequestException("Could not open a new chat.");
    return this.get(principal, scopedClientId, created.id);
  }

  /** Hiding keeps the chat and its history. Showing it again opens it. */
  async setHidden(principal: Principal, threadId: string, hidden: boolean, scopedClientId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const thread = await this.thread(principal, scopedClientId, threadId);
    if (hidden) {
      const [busy] = await this.db.db
        .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(and(eq(chatMessages.threadId, thread.id), eq(chatMessages.status, "working")))
        .limit(1);
      if (busy && busy.createdAt.getTime() > Date.now() - STUCK_MS) {
        throw new BadRequestException("Wait for the answer, or cancel it, before hiding this chat.");
      }
    }
    await this.db.db
      .update(chatThreads)
      .set({ hiddenAt: hidden ? new Date() : null })
      .where(eq(chatThreads.id, thread.id));
    return hidden ? this.get(principal, scopedClientId) : this.get(principal, scopedClientId, thread.id);
  }

  async ask(principal: Principal, text: string, scopedClientId?: string | null, threadId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const ready = await this.ready();
    if (!ready.claude) throw new BadRequestException("Add the Claude API key in Settings first.");
    const thread = await this.thread(principal, scopedClientId, threadId);
    if (thread.hiddenAt) throw new BadRequestException("Show this chat again before asking in it.");
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
    const ctrl = new AbortController();
    this.turns.get(answer!.id)?.abort();
    this.turns.set(answer!.id, ctrl);
    void this.runTurn(principal, thread, answer!.id, scopedClientId ?? null, ctrl.signal).catch((err) =>
      this.log.error(`Jobs chat turn crashed: ${String(err)}`),
    );
    return this.get(principal, scopedClientId, thread.id);
  }

  async cancel(principal: Principal, messageId: string, scopedClientId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const thread = await this.threadOfMessage(principal, messageId, scopedClientId);
    const [row] = await this.db.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.threadId, thread.id)))
      .limit(1);
    if (!row) throw new NotFoundException("That message was not found.");
    this.turns.get(messageId)?.abort();
    const [claimed] = await this.db.db
      .update(chatMessages)
      .set({ status: "failed", error: STOPPED })
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.status, "working")))
      .returning({ id: chatMessages.id });
    if (!claimed) throw new BadRequestException("Nothing is fetching on that message.");
    await this.db.db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));
    return this.get(principal, scopedClientId, thread.id);
  }

  async confirm(principal: Principal, messageId: string, scopedClientId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const thread = await this.threadOfMessage(principal, messageId, scopedClientId);
    if (thread.hiddenAt) throw new BadRequestException("Show this chat again before confirming.");
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
      const result = await this.applyCard(principal, applying, scopedClientId ?? null);
      const done: ChatJobChange = { ...applying, status: "applied", result, error: null };
      await this.db.db.update(chatMessages).set({ jobChange: done }).where(eq(chatMessages.id, row.id));
    } catch (err) {
      const message = explain(err);
      const failed: ChatJobChange = { ...applying, status: "rejected", error: message };
      await this.db.db.update(chatMessages).set({ jobChange: failed }).where(eq(chatMessages.id, row.id));
      throw new BadRequestException(message);
    }
    return this.get(principal, scopedClientId, thread.id);
  }

  /** Saves a person's own changes to a card that is still waiting for Confirm. Nothing reaches the job yet. */
  async editCard(principal: Principal, messageId: string, edit: CardEdit, scopedClientId?: string | null) {
    if (!can(principal, "job.manage")) throw new ForbiddenError();
    const thread = await this.threadOfMessage(principal, messageId, scopedClientId);
    if (thread.hiddenAt) throw new BadRequestException("Show this chat again before changing it.");
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
    const catalog = await this.catalog(principal);
    const revised = reviseCard(card!, edit, { ...catalog, now: Date.now() });
    if (!revised.ok) throw new BadRequestException(revised.error);
    const saved = await this.db.db
      .update(chatMessages)
      .set({ jobChange: revised.card })
      .where(and(eq(chatMessages.id, row.id), sql`${chatMessages.jobChange}->>'status' = 'proposed'`))
      .returning({ id: chatMessages.id });
    if (!saved[0]) throw new BadRequestException("That card was already confirmed.");
    return this.get(principal, scopedClientId, thread.id);
  }

  // Each client page has its own conversation, so one client's job details never carry into another's.
  private async thread(principal: Principal, scopedClientId?: string | null, threadId?: string | null) {
    if (scopedClientId) assertClientVisible(principal, scopedClientId);
    const ownerId = principal.id;
    const kind = jobChatKind(scopedClientId);
    if (threadId) {
      const [chosen] = await this.db.db
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.id, threadId), eq(chatThreads.ownerId, ownerId), eq(chatThreads.kind, kind)))
        .limit(1);
      if (!chosen) throw new NotFoundException("That chat was not found.");
      return chosen;
    }
    const [existing] = await this.db.db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.kind, kind), isNull(chatThreads.hiddenAt)))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(1);
    if (existing) return existing;
    const [created] = await this.db.db
      .insert(chatThreads)
      .values({ ownerId, title: "New chat", kind, model: "haiku" })
      .returning();
    if (!created) throw new BadRequestException("Could not open the jobs chat.");
    return created;
  }

  // A card belongs to its own chat, so Confirm still works after someone switches chats.
  private async threadOfMessage(principal: Principal, messageId: string, scopedClientId?: string | null) {
    const [row] = await this.db.db
      .select({ threadId: chatMessages.threadId })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!row) throw new NotFoundException("That message was not found.");
    return this.thread(principal, scopedClientId, row.threadId);
  }

  private async runTurn(principal: Principal, thread: Thread, messageId: string, scopedClientId: string | null, signal: AbortSignal) {
    const key = (await this.db.db.select().from(connectors).where(eq(connectors.kind, "anthropic")).limit(1))[0]?.secret || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Add the Claude API key in Settings first.");
    const catalog = await this.catalog(principal);
    const history = await this.db.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt));
    const earlier = history.filter((row) => row.id !== messageId);
    const asked = requestText(earlier);
    const messages: Message[] = trimHistory(earlier, HISTORY).map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: historyContent(row),
    }));
    const scope = scopedClientId ? catalog.clients.find((client) => client.id === scopedClientId) : null;
    const system = [
      RULES,
      scope ? `This jobs page is limited to ${scope.name}. Only use that client.` : "This jobs page can see every Time tracking client.",
      rosterLines(catalog, scopedClientId),
    ]
      .filter(Boolean)
      .join("\n");
    const tools = this.tools();
    let lookups: ChatLookup[] = [];
    let jobChange: ChatJobChange | null = null;
    const cards: ChatJobChange[] = [];
    const model = modelFor("sonnet");
    // Extra jobs from one request each get their own card and Confirm, right after the answer.
    const finish = async (values: Partial<typeof chatMessages.$inferInsert>) => {
      const [saved] = await this.db.db
        .update(chatMessages)
        .set({ ...values, lookups, jobChange })
        .where(and(eq(chatMessages.id, messageId), eq(chatMessages.status, "working")))
        .returning({ id: chatMessages.id });
      if (!saved) return;
      for (const [index, card] of cards.slice(1).entries()) {
        await this.db.db.insert(chatMessages).values({
          threadId: thread.id,
          role: "assistant",
          content: `Card ${index + 2} of ${cards.length}: ${card.summary}`,
          jobChange: card,
        });
      }
    };
    try {
      throwIfAborted(signal);
      let reply = await ask(key, { model, system, messages, tools, signal });
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        throwIfAborted(signal);
        const uses = reply.content.filter((block): block is ToolUse => block.type === "tool_use");
        const text = reply.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (uses.length === 0) {
          await finish({ content: text || "Ask me to open a job or assign people.", status: "done", error: null });
          return;
        }
        const results: Block[] = [];
        for (const use of uses) {
          throwIfAborted(signal);
          const [content, isError] = await this.useTool(use, catalog, scopedClientId, asked, (card) => {
            // A retry of the same job replaces its card instead of adding a duplicate.
            const same = cards.findIndex(
              (item) =>
                item.kind === card.kind &&
                (card.kind === "edit_job" || card.kind === "add_tasks" ? item.jobId === card.jobId : item.jobReference === card.jobReference),
            );
            if (same >= 0) cards[same] = card;
            else cards.push(card);
            // Several unnumbered jobs in one request must each get their own number.
            if (card.kind === "create_job") catalog.references.push(card.jobReference);
            jobChange = cards[0] ?? null;
          });
          lookups = [...lookups, { tool: use.name, summary: clip(`${use.name}: ${isError ? content : "ok"}`, 120) }];
          await this.db.db
            .update(chatMessages)
            .set({ lookups, jobChange })
            .where(and(eq(chatMessages.id, messageId), eq(chatMessages.status, "working")));
          results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: isError || undefined });
        }
        messages.push({ role: "assistant", content: reply.content });
        messages.push({ role: "user", content: results });
        reply = await ask(key, { model, system, messages, tools, signal });
      }
      await finish({ content: "That took too many steps. Ask again with the client, job reference, and people named.", status: "done" });
    } catch (err) {
      if (!isCancelled(err)) {
        const reason = err instanceof Error ? err.message : "Something went wrong.";
        await finish({ status: "failed", error: clip(reason, 400) });
      }
    } finally {
      this.turns.delete(messageId);
    }
  }

  private tools(): ClaudeTool[] {
    return [
      {
        name: "list_ops_clients",
        description: "List Time tracking clients. Use the exact name (or code) from the records in propose_create_job.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "list_ops_people",
        description: "List people on the Time tracking list. Filter with query (name or badge) and client_name. Copy names exactly into propose tools.",
        input_schema: {
          type: "object",
          properties: { client_name: { type: "string" }, query: { type: "string" } },
        },
      },
      {
        name: "list_ops_jobs",
        description: "List open Time tracking jobs. Copy the exact job reference into propose_assign_people.",
        input_schema: {
          type: "object",
          properties: { client_name: { type: "string" }, query: { type: "string" } },
        },
      },
      {
        name: "propose_create_job",
        description: "Prepare one card to open one job. Does not save the job until the owner confirms. Call once per job.",
        input_schema: {
          type: "object",
          properties: {
            client_name: { type: "string", description: "Exact client name from list_ops_clients." },
            reference: { type: "string", description: "Only if the person typed a reference. Leave out and the app numbers the job." },
            title: { type: "string", description: "Short description of the work in the person's words." },
            bill_basis: { type: "string", enum: ["time", "pallet", "carton", "sku", "mixed"], description: "Only if the person said how to bill." },
            people: { type: "array", items: { type: "string" }, description: "Only people the person named, copied from list_ops_people." },
            tasks: TASKS_SCHEMA,
            not_saved: { type: "array", items: { type: "string" }, description: "Details they asked for that this card cannot store, such as dates, times, quantities, docks, or tasks." },
          },
          required: ["client_name", "title"],
        },
      },
      {
        name: "propose_add_tasks",
        description: "Prepare a card that adds tasks to one open job and assigns them. Put every new task in one call. Does not save until Confirm.",
        input_schema: {
          type: "object",
          properties: {
            job_reference: { type: "string", description: "Exact reference from list_ops_jobs." },
            tasks: TASKS_SCHEMA,
            not_saved: { type: "array", items: { type: "string" }, description: "Details they asked for that a task cannot store." },
          },
          required: ["job_reference", "tasks"],
        },
      },
      {
        name: "propose_edit_job",
        description: "Prepare a card that changes one open job. Pass only the fields they asked to change. Does not save until Confirm.",
        input_schema: {
          type: "object",
          properties: {
            job_reference: { type: "string", description: "Exact current reference from list_ops_jobs." },
            new_title: { type: "string", description: "Only if they asked to change the title or the work described." },
            new_reference: { type: "string", description: "Only if they typed a new reference." },
            bill_basis: { type: "string", enum: ["time", "pallet", "carton", "sku", "mixed"], description: "Only if they said to change how it is billed." },
            add_people: { type: "array", items: { type: "string" }, description: "People they named to add, copied from list_ops_people." },
            remove_people: { type: "array", items: { type: "string" }, description: "People they named to take off, copied from the job's crew." },
            not_saved: { type: "array", items: { type: "string" }, description: "Details they asked for that a job cannot store." },
          },
          required: ["job_reference"],
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
            not_saved: { type: "array", items: { type: "string" }, description: "Details they asked for that this card cannot store, such as start times or tasks." },
          },
          required: ["job_reference", "people"],
        },
      },
    ];
  }

  private async useTool(
    use: ToolUse,
    catalog: { clients: OpsClient[]; people: OpsPerson[]; jobs: OpsJob[]; references: string[]; work: OpsWork[] },
    scopedClientId: string | null,
    asked: string,
    save: (card: JobCard) => void,
  ): Promise<[string, boolean]> {
    const args = asRecord(use.input);
    try {
      if (use.name === "list_ops_clients") {
        const rows = catalog.clients.filter((client) => !scopedClientId || client.id === scopedClientId);
        return [JSON.stringify({ records: rows.map((client) => ({ name: client.name, code: client.code ?? null })) }), false];
      }
      if (use.name === "list_ops_people") {
        const query = String(args.query ?? "").trim().toLowerCase();
        const clientName = String(args.client_name ?? "").trim().toLowerCase();
        const clientHit = clientName ? catalog.clients.find((item) => item.name.trim().toLowerCase() === clientName || (item.code && item.code.toLowerCase() === clientName)) : null;
        const rows = catalog.people.filter((person) => {
          if (scopedClientId && person.clientId && person.clientId !== scopedClientId) return false;
          if (clientHit && person.clientId && person.clientId !== clientHit.id) return false;
          if (query && !personFits(person, query)) return false;
          return true;
        });
        return [
          JSON.stringify({
            records: rows.slice(0, 80).map((person) => ({
              name: person.name,
              badge: person.badgeCode ?? null,
              client: catalog.clients.find((item) => item.id === person.clientId)?.name ?? null,
            })),
          }),
          false,
        ];
      }
      if (use.name === "list_ops_jobs") {
        const query = String(args.query ?? "").trim().toLowerCase();
        const clientName = String(args.client_name ?? "").trim().toLowerCase();
        const clientHit = clientName ? catalog.clients.find((item) => item.name.trim().toLowerCase() === clientName || (item.code && item.code.toLowerCase() === clientName)) : null;
        const rows = catalog.jobs.filter((job) => {
          if (scopedClientId && job.clientId !== scopedClientId) return false;
          if (clientHit && job.clientId !== clientHit.id) return false;
          if (query && !jobFits(job, query)) return false;
          return job.status !== "done";
        });
        return [
          JSON.stringify({
            records: rows.slice(0, 80).map((job) => ({
              reference: job.reference,
              title: job.title,
              status: job.status,
              bill_by: job.billBasis ?? "mixed",
              crew: (job.crew ?? []).map((person) => person.name),
              open_tasks: (job.tasks ?? []).filter((task) => task.status !== "done").map((task) => task.title),
              client: catalog.clients.find((item) => item.id === job.clientId)?.name ?? null,
            })),
          }),
          false,
        ];
      }
      if (use.name === "propose_create_job") {
        const parsed = parseCreateJob(args, { ...catalog, now: Date.now(), scopedClientId, asked });
        if (!parsed.ok) return [parsed.error, true];
        save(parsed.card);
        return [JSON.stringify({ ok: true, summary: parsed.card.summary }), false];
      }
      if (use.name === "propose_add_tasks") {
        const parsed = parseAddTasks(args, { ...catalog, now: Date.now(), scopedClientId, asked });
        if (!parsed.ok) return [parsed.error, true];
        save(parsed.card);
        return [JSON.stringify({ ok: true, summary: parsed.card.summary }), false];
      }
      if (use.name === "propose_edit_job") {
        const parsed = parseEditJob(args, { ...catalog, now: Date.now(), scopedClientId, asked });
        if (!parsed.ok) return [parsed.error, true];
        save(parsed.card);
        return [JSON.stringify({ ok: true, summary: parsed.card.summary }), false];
      }
      if (use.name === "propose_assign_people") {
        const parsed = parseAssignPeople(args, { ...catalog, now: Date.now(), scopedClientId, asked });
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
      code: client.code,
      hidden: client.hidden,
      enabledServices: client.enabledServices,
    }));
    const visible = new Set(board.clients.map((client) => client.id));
    const people: OpsPerson[] = (await this.db.db.select().from(employees)).map((person) => ({
      id: person.id,
      name: person.name,
      clientId: person.clientId,
      active: person.active,
      badgeCode: person.badgeCode,
    }));
    const jobRows: OpsJob[] = (await this.db.db.select().from(jobs)).map((job) => ({
      id: job.id,
      reference: job.reference,
      title: job.title,
      clientId: job.clientId,
      status: job.status,
      billBasis: job.billBasis,
      crew: board.jobs.find((row) => row.id === job.id)?.assignees.map((person) => ({ employeeId: person.employeeId, name: person.name })) ?? [],
      tasks: board.jobs.find((row) => row.id === job.id)?.tasks.map((task) => ({ title: task.title, status: task.status, assigneeId: task.assigneeId })) ?? [],
    }));
    const work: OpsWork[] = (await this.db.db.select().from(activityTypes))
      .filter((row) => row.active && row.billable && row.department !== "indirect")
      .map((row) => ({ code: row.code, name: row.name, department: row.department, clientId: row.clientId }));
    return {
      work,
      clients: clients.filter((client) => !client.hidden && visible.has(client.id)),
      people: people.filter((person) => person.active !== false && board.people.some((item) => item.id === person.id)),
      jobs: jobRows.filter((job) => visible.has(job.clientId)),
      // References are unique across every client, including ones this person cannot see.
      references: jobRows.map((job) => job.reference),
    };
  }

  private async applyCard(principal: Principal, card: JobCard, scopedClientId: string | null) {
    const catalog = await this.catalog(principal);
    const blocked = recheckCard(card, { ...catalog, scopedClientId });
    if (blocked) throw new Error(blocked);
    if (card.kind === "edit_job") {
      if (!card.jobId || !card.before) throw new Error("That job changed. Ask again.");
      const edited = await this.jobs.edit(principal, card.jobId, {
        ...(card.jobReference !== card.before.reference ? { reference: card.jobReference } : {}),
        ...(card.title !== card.before.title ? { title: card.title } : {}),
        ...(card.billBasis && card.billBasis !== card.before.billBasis ? { billBasis: card.billBasis } : {}),
        addIds: card.people.map((person) => person.employeeId),
        removeIds: (card.removePeople ?? []).map((person) => person.employeeId),
        before: card.before,
      });
      return edited.message;
    }
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
    if (card.tasks) {
      let added = 0;
      for (const task of card.tasks) {
        try {
          await this.jobs.addCrewTask(principal, jobId, {
            title: task.title,
            activityCode: task.activityCode,
            employeeId: task.employeeId,
          });
          added += 1;
        } catch (err) {
          // Earlier tasks are already saved, so name exactly which one is missing.
          notes.push(`Could not add ${task.title}${task.name ? ` for ${task.name}` : ""}: ${explain(err)}`);
        }
      }
      if (added > 0) notes.push(`${added} task${added === 1 ? "" : "s"} added to ${card.jobReference}.`);
      return notes.join(" ");
    }
    for (const person of card.people) {
      try {
        const assigned = await this.jobs.assign(principal, jobId, person.employeeId);
        notes.push(assigned.message);
      } catch (err) {
        // The job already exists at this point, so say exactly who is missing instead of failing the card.
        if (card.kind !== "create_job") throw err;
        notes.push(`Could not assign ${person.name}: ${explain(err)}`);
      }
    }
    if (notes.length === 0) return `${card.jobReference} is assigned.`;
    return notes.join(" ");
  }
}

function rosterLines(catalog: { clients: OpsClient[]; people: OpsPerson[]; jobs: OpsJob[]; work: OpsWork[] }, scopedClientId: string | null) {
  const clients = catalog.clients.filter((client) => !scopedClientId || client.id === scopedClientId);
  const jobs = catalog.jobs.filter((job) => job.status !== "done" && (!scopedClientId || job.clientId === scopedClientId));
  const people = catalog.people.filter((person) => !scopedClientId || !person.clientId || person.clientId === scopedClientId);
  const clientBit = clients
    .slice(0, 40)
    .map((client) => (client.code ? `${client.name} (${client.code})` : client.name))
    .join("; ");
  const jobBit = jobs
    .slice(0, 30)
    .map((job) => job.reference)
    .join(", ");
  const peopleBit = people
    .slice(0, 40)
    .map((person) => person.name)
    .join(", ");
  const partial = clients.length > 40 || jobs.length > 30 || people.length > 40 ? "\nThis list is cut short. Use the list tools with a query before saying someone or something is missing." : "";
  const scope = scopedClientId ? clients[0] : null;
  const workBit = [
    ...new Set(
      catalog.work
        .filter((row) => !scope || ((!row.clientId || row.clientId === scope.id) && (!scope.enabledServices || scope.enabledServices.includes(row.department))))
        .map((row) => row.name),
    ),
  ].join(", ");
  return `Live Time tracking list — copy these names exactly.\nClients: ${clientBit || "none"}.\nOpen jobs: ${jobBit || "none"}.\nPeople: ${peopleBit || "none"}.\nWork types: ${workBit || "none"}.${partial}`;
}

function personFits(person: OpsPerson, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = person.name.toLowerCase();
  const badge = (person.badgeCode ?? "").toLowerCase();
  return name === q || name.startsWith(`${q} `) || name.split(/\s+/).includes(q) || badge === q || badge.replace(/\s+/g, "") === q.replace(/\s+/g, "");
}

function jobFits(job: OpsJob, query: string) {
  const q = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!q) return true;
  const ref = job.reference.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const title = job.title.toLowerCase();
  return ref === q || ref.startsWith(q) || title === query.trim().toLowerCase();
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
