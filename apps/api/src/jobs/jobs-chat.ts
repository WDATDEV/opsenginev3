import { jobWorkCodes } from "../tracking/job-work.js";

export const JOB_CHAT_KIND = "jobs";
export const JOB_CHAT_TTL_MS = 15 * 60_000;
export const BILL_BASES = ["time", "pallet", "carton", "sku", "mixed"] as const;

export type OpsClient = { id: string; name: string; code?: string; hidden?: boolean; enabledServices?: string[] };
export type OpsPerson = { id: string; name: string; clientId: string | null; active?: boolean; badgeCode?: string | null };
export type OpsJob = {
  id: string;
  reference: string;
  title: string;
  clientId: string;
  status: string;
  billBasis?: string;
  crew?: { employeeId: string; name: string }[];
  tasks?: { title: string; status: string; assigneeId: string | null }[];
};

export type OpsWork = { code: string; name: string; department: string; clientId: string | null };
export type CardTask = { title: string; activityCode: string; activityName: string; employeeId: string | null; name: string | null };

export type JobCardKind = "create_job" | "assign_people" | "edit_job" | "add_tasks";

export type JobCard = {
  kind: JobCardKind;
  clientId: string;
  clientName: string;
  jobId: string | null;
  jobReference: string;
  title: string;
  billBasis: string | null;
  people: { employeeId: string; name: string }[];
  summary: string;
  // Details the person asked for that a job card cannot store, shown so they are never lost silently.
  notSaved?: string[];
  // Only on edit_job: people leaving the crew, the crew now, and the values being replaced.
  removePeople?: { employeeId: string; name: string }[];
  crewBefore?: { employeeId: string; name: string }[];
  before?: { reference: string; title: string; billBasis: string };
  // One row per person, so each person sees their own task on the floor phone.
  tasks?: CardTask[];
  workOptions?: { code: string; name: string }[];
  status: "proposed" | "applying" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  result: string | null;
  error: string | null;
};

type HistoryRow = {
  role: string;
  content: string;
  jobChange?: (Pick<JobCard, "jobReference" | "title" | "clientName" | "billBasis" | "people" | "status"> & Pick<Partial<JobCard>, "kind" | "removePeople" | "before" | "tasks">) | null;
};

export function jobChatKind(scopedClientId?: string | null) {
  return scopedClientId ? `${JOB_CHAT_KIND}:${scopedClientId}` : JOB_CHAT_KIND;
}

// The Messages API needs the first message to come from the user.
export function trimHistory<T extends { role: string }>(rows: T[], max: number) {
  const recent = rows.slice(-max);
  const first = recent.findIndex((row) => row.role === "user");
  return first < 0 ? [] : recent.slice(first);
}

export function historyContent(row: HistoryRow) {
  const text = row.content || "(no text)";
  const card = row.jobChange;
  if (row.role !== "assistant" || !card) return text;
  const crew = card.people.map((person) => person.name).join(", ") || "nobody";
  if (card.kind === "edit_job") {
    const leaving = card.removePeople?.map((person) => person.name).join(", ") || "nobody";
    return `${text}\n[App note: edit card for ${card.before?.reference ?? card.jobReference}, ${card.clientName}. New reference ${card.jobReference}, title "${card.title}", bill by ${card.billBasis ?? "unchanged"}, adding: ${crew}, removing: ${leaving}. Status: ${card.status}.]`;
  }
  const work = card.tasks?.length
    ? ` Tasks: ${card.tasks.map((task) => `${task.title} (${task.activityName}, ${task.name ?? "nobody yet"})`).join("; ")}.`
    : "";
  return `${text}\n[App note: card for ${card.jobReference}, "${card.title}", ${card.clientName}, bill by ${card.billBasis ?? "unchanged"}, people: ${crew}.${work} Status: ${card.status}.]`;
}

const DEFAULT_TITLES = new Set(["jobs", "new chat"]);

/** A chat is named after the first thing asked in it. */
export function sessionTitle(title: string, firstAsked?: string | null) {
  if (!DEFAULT_TITLES.has(title.trim().toLowerCase())) return title;
  const said = firstAsked?.replace(/\s+/g, " ").trim();
  if (!said) return "New chat";
  return said.length > 48 ? `${said.slice(0, 47).trimEnd()}…` : said;
}

export function sessionSummary(
  thread: { id: string; title: string; updatedAt: Date; hiddenAt: Date | null },
  rows: { role: string; content: string; status: string; createdAt: Date; jobChange?: { status: string; expiresAt: string } | null }[],
  now: number,
  stuckMs: number,
) {
  return {
    id: thread.id,
    title: sessionTitle(thread.title, rows.find((row) => row.role === "user")?.content),
    updatedAt: thread.updatedAt,
    hidden: Boolean(thread.hiddenAt),
    messages: rows.length,
    // Cards still waiting for Confirm. Expired ones cannot be confirmed, so they do not count.
    waiting: rows.filter((row) => row.jobChange?.status === "proposed" && Date.parse(row.jobChange.expiresAt) > now).length,
    working: rows.some((row) => row.status === "working" && row.createdAt.getTime() > now - stuckMs),
  };
}

const AGREED = /^(yes|yep|yeah|ok|okay|sure|correct|right|confirm|go ahead|do it|that'?s (it|right))\b/i;

/**
 * The words a new card may rely on: what the person said since the last card, plus any card
 * they are still changing. An old, finished job can never leak details into a new one.
 */
export function requestText(rows: HistoryRow[]) {
  let start = 0;
  rows.forEach((row, index) => {
    if (row.role === "assistant" && row.jobChange) start = index + 1;
  });
  const since = rows.slice(start);
  const lastUser = [...since].reverse().find((row) => row.role === "user")?.content ?? "";
  const spoken = since.filter((row) => row.role === "user" || AGREED.test(lastUser.trim())).map((row) => row.content);
  const open: string[] = [];
  for (let index = start - 1; index >= 0; index -= 1) {
    const card = rows[index]?.jobChange;
    if (!card) break;
    if (card.status === "applied") continue;
    open.push(card.jobReference, card.title, card.clientName, ...card.people.map((person) => person.name));
    open.push(...(card.removePeople ?? []).map((person) => person.name));
    open.push(...(card.tasks ?? []).flatMap((task) => [task.title, task.activityName, task.name ?? ""]));
    if (card.billBasis && card.billBasis !== "mixed") open.push(`billed by ${card.billBasis}`);
  }
  return [...spoken, ...open].join("\n");
}

const STOP_WORDS = new Set(
  "a an and at by co company create for group in inc job jobs llc ltd make new of on open please start the to with add assign client".split(" "),
);

function nameWords(value: string) {
  return fold(value)
    .split(" ")
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

function nameStatus<T extends { id: string; name: string; code?: string; badgeCode?: string | null }>(asked: string, pool: T[], item: T) {
  const said = ` ${fold(asked)} `;
  const has = (word: string) => Boolean(word) && said.includes(` ${word} `);
  if (has(fold(item.name)) || codesOf(item).some((code) => has(fold(code)))) return "named";
  const hits = nameWords(item.name).filter(has);
  if (hits.length === 0) return "missing";
  const rivals = pool.filter((other) => other.id !== item.id && hits.every((word) => nameWords(other.name).includes(word)));
  return rivals.length > 0 ? "ambiguous" : "named";
}

function checkPeopleNamed(asked: string, pool: OpsPerson[], picked: { employeeId: string; name: string }[]) {
  for (const person of picked) {
    const item = pool.find((row) => row.id === person.employeeId);
    if (!item) return `${person.name} is not on the Time tracking list.`;
    const status = nameStatus(asked, pool, item);
    if (status === "missing") return `${person.name} was not named in the request. Do not add them. Ask who should be on this job.`;
    if (status === "ambiguous") return `More than one person fits for ${person.name}. Ask which one they mean.`;
  }
  return null;
}

const BILL_ALIASES: Record<string, (typeof BILL_BASES)[number]> = {
  time: "time",
  hour: "time",
  hours: "time",
  hourly: "time",
  labor: "time",
  labour: "time",
  pallet: "pallet",
  pallets: "pallet",
  carton: "carton",
  cartons: "carton",
  box: "carton",
  boxes: "carton",
  sku: "sku",
  skus: "sku",
  mixed: "mixed",
};

function billBasisFrom(value: string) {
  const words = fold(value).split(" ");
  for (const word of words) {
    const basis = BILL_ALIASES[word];
    if (basis) return basis;
  }
  return null;
}

// "20 pallets" describes the work. Only "per pallet" or "bill by pallet" sets how it is billed.
function billStated(asked: string, basis: string) {
  const words = Object.entries(BILL_ALIASES)
    .filter(([, value]) => value === basis)
    .map(([word]) => word)
    .join("|");
  const said = fold(asked);
  if (basis === "time" && /\bhourly\b/.test(said)) return true;
  return new RegExp(`\\b(bill|billed|billing|charge|charged|charging|rate|price|priced|per|by)\\s+(\\w+\\s+){0,2}(${words})\\b`).test(said);
}

function nextReference(code: string | undefined, name: string, taken: string[]) {
  const prefix = (compact(code || name).toUpperCase().slice(0, 12) || "JOB");
  const used = new Set(taken.map(compact));
  let highest = 1000;
  for (const reference of taken) {
    const match = reference.trim().toUpperCase().match(new RegExp(`^${prefix}[^A-Z0-9]*(\\d+)$`));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  let next = highest + 1;
  while (used.has(compact(`${prefix}-${next}`))) next += 1;
  return `${prefix}-${next}`;
}

// A title must come from what was asked, so a job is never described with made-up work.
function titleFromRequest(title: string, asked: string, ignore: string[]) {
  const skip = new Set(ignore.flatMap(nameWords));
  const stem = (word: string) => word.slice(0, 4);
  const said = new Set(nameWords(asked).filter((word) => !skip.has(word)).map(stem));
  return nameWords(title).some((word) => word.length >= 3 && !skip.has(word) && said.has(stem(word)));
}

// On an edit, every word the title gains must come from the request. Words it keeps are already on the job.
function titleChangeAsked(next: string, current: string, asked: string) {
  const words = (value: string) => fold(value).split(" ").filter(Boolean);
  const key = (word: string) => (/\d/.test(word) ? word : word.slice(0, 4));
  const kept = new Set(words(current).map(key));
  const said = new Set(words(asked).map(key));
  return words(next)
    .filter((word) => !STOP_WORDS.has(word))
    .every((word) => kept.has(key(word)) || said.has(key(word)));
}

function editCard(
  job: OpsJob,
  clientName: string,
  change: {
    title: string;
    reference: string;
    billBasis: string;
    add: { employeeId: string; name: string }[];
    remove: { employeeId: string; name: string }[];
    notSaved?: string[];
    references: string[];
    now: number;
  },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const before = { reference: job.reference, title: job.title, billBasis: job.billBasis ?? "mixed" };
  if (change.title.length > 120) return { ok: false, error: "A job title can be 120 characters at most." };
  if (change.reference.length > 40) return { ok: false, error: "A job reference can be 40 characters at most." };
  if (compact(change.reference) !== compact(job.reference) && change.references.some((item) => compact(item) === compact(change.reference))) {
    return { ok: false, error: `Job ${change.reference} is already on file. Pick a different reference.` };
  }
  const parts: string[] = [];
  if (change.reference !== before.reference) parts.push(`reference to ${change.reference}`);
  if (change.title !== before.title) parts.push(`title to ${change.title}`);
  if (change.billBasis !== before.billBasis) parts.push(`bill by to ${change.billBasis}`);
  if (change.add.length) parts.push(`add ${change.add.map((person) => person.name).join(", ")}`);
  if (change.remove.length) parts.push(`remove ${change.remove.map((person) => person.name).join(", ")}`);
  if (parts.length === 0) return { ok: false, error: `${job.reference} is already set that way. Nothing to change.` };
  return {
    ok: true,
    card: {
      kind: "edit_job",
      clientId: job.clientId,
      clientName,
      jobId: job.id,
      jobReference: change.reference,
      title: change.title,
      billBasis: change.billBasis,
      people: change.add,
      removePeople: change.remove,
      crewBefore: job.crew ?? [],
      before,
      summary: `Change ${job.reference}: ${parts.join("; ")}.`,
      ...(change.notSaved?.length ? { notSaved: change.notSaved } : {}),
      status: "proposed",
      proposedAt: new Date(change.now).toISOString(),
      expiresAt: new Date(change.now + JOB_CHAT_TTL_MS).toISOString(),
      result: null,
      error: null,
    },
  };
}

export function parseEditJob(
  args: Record<string, unknown>,
  catalog: { jobs: OpsJob[]; people: OpsPerson[]; clients: OpsClient[]; references: string[]; now: number; scopedClientId?: string | null; asked?: string },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const target = text(args.job_reference ?? args.jobReference);
  if (!target) return { ok: false, error: "Name the job to change." };
  const open = catalog.jobs.filter((job) => job.status !== "done" && (!catalog.scopedClientId || job.clientId === catalog.scopedClientId));
  const hit = matchJob(open, target);
  if (!hit.ok) return hit;
  const job = hit.item;
  const asked = catalog.asked;
  const title = text(args.new_title) || job.title;
  const reference = text(args.new_reference) || job.reference;
  const billText = text(args.bill_basis);
  let billBasis = job.billBasis ?? "mixed";
  if (billText) {
    const basis = billBasisFrom(billText);
    if (!basis) return { ok: false, error: "Bill by must be time, pallet, carton, sku, or mixed." };
    if (asked !== undefined && basis !== billBasis) {
      const mixedAsked = basis === "mixed" && /\b(mixed|time and quantity)\b/.test(fold(asked));
      if (!mixedAsked && !billStated(asked, basis)) return { ok: false, error: "The request does not say how to bill. Ask them." };
    }
    billBasis = basis;
  }
  if (asked !== undefined && reference !== job.reference && !compact(asked).includes(compact(reference))) {
    return { ok: false, error: `The reference ${reference} was not in the request. Ask what it should be.` };
  }
  if (asked !== undefined && title !== job.title && !titleChangeAsked(title, job.title, asked)) {
    return { ok: false, error: "The new title has words the person did not say. Use their words, or ask." };
  }
  const crew = job.crew ?? [];
  const pool = catalog.people.filter((person) => !person.clientId || person.clientId === job.clientId);
  const addNames = namesOf(args.add_people);
  const added = addNames.length ? matchPeople(pool, addNames) : { ok: true as const, people: [] };
  if (!added.ok) return added;
  if (asked !== undefined) {
    const unnamed = checkPeopleNamed(asked, pool, added.people);
    if (unnamed) return { ok: false, error: unnamed };
  }
  const crewPool: OpsPerson[] = crew.map((person) => ({ id: person.employeeId, name: person.name, clientId: job.clientId, active: true }));
  const removeNames = namesOf(args.remove_people);
  const removed = removeNames.length ? matchPeople(crewPool, removeNames) : { ok: true as const, people: [] };
  if (!removed.ok) return { ok: false, error: `${removed.error} Only people on ${job.reference} can be removed.` };
  if (asked !== undefined) {
    const unnamed = checkPeopleNamed(asked, crewPool, removed.people);
    if (unnamed) return { ok: false, error: unnamed };
  }
  if (added.people.some((person) => removed.people.some((row) => row.employeeId === person.employeeId))) {
    return { ok: false, error: "The same person cannot be added and removed. Ask which they want." };
  }
  const client = catalog.clients.find((item) => item.id === job.clientId);
  return editCard(job, client?.name ?? "Client", {
    title,
    reference,
    billBasis,
    add: added.people.filter((person) => !crew.some((row) => row.employeeId === person.employeeId)),
    remove: removed.people,
    notSaved: namesOf(args.not_saved).slice(0, 10),
    references: catalog.references,
    now: catalog.now,
  });
}

export type CardEdit = {
  title?: string;
  reference?: string;
  billBasis?: string;
  employeeIds?: string[];
  tasks?: { title: string; activityCode: string; employeeId: string | null }[];
};

export function workOptions(client: OpsClient, work: OpsWork[]) {
  return work
    .filter(
      (row) =>
        (!row.clientId || row.clientId === client.id) &&
        (!client.enabledServices || client.enabledServices.includes(row.department)),
    )
    .map((row) => ({ code: row.code, name: row.name }));
}

function workSaid(asked: string, option: { code: string; name: string }) {
  if (jobWorkCodes(asked)?.includes(option.code)) return true;
  return ` ${fold(asked)} `.includes(` ${fold(option.name)} `);
}

function chooseWork(wanted: string, title: string, options: { code: string; name: string }[], asked: string | undefined, clientName: string) {
  const names = options.map((row) => row.name).join(", ") || "none";
  let option: { code: string; name: string } | undefined;
  if (wanted) {
    option = options.find((row) => row.code === wanted || fold(row.name) === fold(wanted));
    if (!option) return { ok: false as const, error: `${wanted} is not turned on for ${clientName}. Available work: ${names}.` };
  } else {
    const codes = jobWorkCodes(title);
    if (!codes) return { ok: false as const, error: `Ask what kind of work "${title}" is. Available work: ${names}.` };
    if (codes.length > 1) return { ok: false as const, error: `"${title}" covers more than one kind of work. Make one task for each.` };
    option = options.find((row) => row.code === codes[0]);
    if (!option) return { ok: false as const, error: `That work is not turned on for ${clientName}. Available work: ${names}.` };
  }
  if (asked !== undefined && !workSaid(asked, option)) {
    return { ok: false as const, error: `The request does not say this is ${option.name}. Ask what kind of work it is.` };
  }
  return { ok: true as const, option };
}

function buildTasks(
  raw: unknown,
  context: {
    client: OpsClient;
    fallbackTitle: string | null;
    defaultPeople: string[];
    pool: OpsPerson[];
    options: { code: string; name: string }[];
    asked: string | undefined;
    ignore: string[];
  },
): { ok: true; tasks: CardTask[]; people: { employeeId: string; name: string }[] } | { ok: false; error: string } {
  const given = (Array.isArray(raw) ? raw : []).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (given.length === 0 && !context.fallbackTitle) return { ok: false, error: "Say what task to add." };
  const list: Record<string, unknown>[] = given.length > 0 ? given : [{ title: context.fallbackTitle }];
  const tasks: CardTask[] = [];
  const people = new Map<string, string>();
  for (const item of list) {
    const title = text(item.title);
    if (!title) return { ok: false, error: "Give each task a short title." };
    if (title.length > 120) return { ok: false, error: "A task title can be 120 characters at most." };
    if (given.length > 0 && context.asked !== undefined && !titleFromRequest(title, context.asked, context.ignore)) {
      return { ok: false, error: `The request does not describe the task "${title}". Use their words, or ask.` };
    }
    const work = chooseWork(text(item.work_type), title, context.options, context.asked, context.client.name);
    if (!work.ok) return work;
    let names = namesOf(item.people);
    if (names.length === 0 && context.defaultPeople.length > 0) {
      if (list.length > 1) return { ok: false, error: `Ask who does the task "${title}".` };
      names = context.defaultPeople;
    }
    const crew = names.length ? matchPeople(context.pool, names) : { ok: true as const, people: [] };
    if (!crew.ok) return crew;
    if (context.asked !== undefined) {
      const unnamed = checkPeopleNamed(context.asked, context.pool, crew.people);
      if (unnamed) return { ok: false, error: unnamed };
    }
    const row = { title, activityCode: work.option.code, activityName: work.option.name };
    if (crew.people.length === 0) tasks.push({ ...row, employeeId: null, name: null });
    for (const person of crew.people) {
      tasks.push({ ...row, employeeId: person.employeeId, name: person.name });
      people.set(person.employeeId, person.name);
    }
  }
  if (tasks.length > 40) return { ok: false, error: "One card can hold 40 tasks at most." };
  return { ok: true, tasks, people: [...people].map(([employeeId, name]) => ({ employeeId, name })) };
}

const taskCount = (count: number) => `${count} task${count === 1 ? "" : "s"}`;

export function parseAddTasks(
  args: Record<string, unknown>,
  catalog: { jobs: OpsJob[]; people: OpsPerson[]; clients: OpsClient[]; work: OpsWork[]; now: number; scopedClientId?: string | null; asked?: string },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const target = text(args.job_reference ?? args.jobReference);
  if (!target) return { ok: false, error: "Name the job to add tasks to." };
  const open = catalog.jobs.filter((job) => job.status !== "done" && (!catalog.scopedClientId || job.clientId === catalog.scopedClientId));
  const hit = matchJob(open, target);
  if (!hit.ok) return hit;
  const job = hit.item;
  const client = catalog.clients.find((item) => item.id === job.clientId);
  if (!client) return { ok: false, error: "That client is no longer on the Time tracking list." };
  const options = workOptions(client, catalog.work);
  const built = buildTasks(args.tasks, {
    client,
    fallbackTitle: null,
    defaultPeople: [],
    pool: catalog.people.filter((person) => !person.clientId || person.clientId === job.clientId),
    options,
    asked: catalog.asked,
    ignore: [client.name, client.code ?? "", job.reference],
  });
  if (!built.ok) return built;
  const repeat = built.tasks.find((task) =>
    job.tasks?.some((row) => row.status !== "done" && fold(row.title) === fold(task.title) && row.assigneeId === task.employeeId),
  );
  if (repeat) return { ok: false, error: `${repeat.name ?? "Nobody"} already has the open task ${repeat.title} on ${job.reference}.` };
  const notSaved = namesOf(args.not_saved).slice(0, 10);
  return {
    ok: true,
    card: {
      kind: "add_tasks",
      clientId: job.clientId,
      clientName: client.name,
      jobId: job.id,
      jobReference: job.reference,
      title: job.title,
      billBasis: null,
      people: built.people,
      tasks: built.tasks,
      workOptions: options,
      summary: `Add ${taskCount(built.tasks.length)} to ${job.reference}.`,
      ...(notSaved.length ? { notSaved } : {}),
      status: "proposed",
      proposedAt: new Date(catalog.now).toISOString(),
      expiresAt: new Date(catalog.now + JOB_CHAT_TTL_MS).toISOString(),
      result: null,
      error: null,
    },
  };
}

/** A person's own edit to a card still waiting for Confirm. They typed it, so only the records are checked. */
export function reviseCard(
  card: JobCard,
  edit: CardEdit,
  catalog: { jobs: OpsJob[]; people: OpsPerson[]; clients: OpsClient[]; references: string[]; now: number },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const pool = catalog.people.filter((person) => !person.clientId || person.clientId === card.clientId);
  const person = (id: string) => pool.find((row) => row.id === id);
  const fresh = { proposedAt: new Date(catalog.now).toISOString(), expiresAt: new Date(catalog.now + JOB_CHAT_TTL_MS).toISOString() };

  if (card.kind === "edit_job") {
    const job = catalog.jobs.find((item) => item.id === card.jobId);
    if (!job || job.status === "done" || job.clientId !== card.clientId) return { ok: false, error: "That job changed. Ask again." };
    const crew = job.crew ?? [];
    const finalIds = edit.employeeIds ?? [
      ...crew.map((row) => row.employeeId).filter((id) => !card.removePeople?.some((row) => row.employeeId === id)),
      ...card.people.map((row) => row.employeeId),
    ];
    const add: { employeeId: string; name: string }[] = [];
    for (const id of new Set(finalIds)) {
      if (crew.some((row) => row.employeeId === id)) continue;
      const row = person(id);
      if (!row) return { ok: false, error: "Someone on that list cannot work on this job." };
      add.push({ employeeId: row.id, name: row.name });
    }
    const next = editCard(job, card.clientName, {
      title: edit.title ?? card.title,
      reference: edit.reference ?? card.jobReference,
      billBasis: edit.billBasis ?? card.billBasis ?? job.billBasis ?? "mixed",
      add,
      remove: crew.filter((row) => !finalIds.includes(row.employeeId)),
      ...(card.notSaved ? { notSaved: card.notSaved } : {}),
      references: catalog.references,
      now: catalog.now,
    });
    return next;
  }

  let revisedTasks: CardTask[] | null = null;
  if (edit.tasks) {
    if (card.kind !== "create_job" && card.kind !== "add_tasks") return { ok: false, error: "This card has no tasks to change." };
    if (edit.tasks.length === 0) return { ok: false, error: "Keep at least one task." };
    revisedTasks = [];
    for (const task of edit.tasks) {
      const title = task.title.trim();
      if (!title || title.length > 120) return { ok: false, error: "Give each task a title of up to 120 characters." };
      const option = card.workOptions?.find((row) => row.code === task.activityCode);
      if (!option) return { ok: false, error: `Choose an available kind of work for ${title}.` };
      const assignee = task.employeeId ? person(task.employeeId) : null;
      if (task.employeeId && !assignee) return { ok: false, error: "Someone on that list cannot work on this job." };
      revisedTasks.push({
        title,
        activityCode: option.code,
        activityName: option.name,
        employeeId: assignee?.id ?? null,
        name: assignee?.name ?? null,
      });
    }
  }
  if (card.kind === "add_tasks") {
    const tasks = revisedTasks ?? card.tasks ?? [];
    const crew = new Map(tasks.filter((task) => task.employeeId).map((task) => [task.employeeId!, task.name ?? "Someone"]));
    return {
      ok: true,
      card: {
        ...card,
        ...fresh,
        tasks,
        people: [...crew].map(([employeeId, name]) => ({ employeeId, name })),
        summary: `Add ${taskCount(tasks.length)} to ${card.jobReference}.`,
      },
    };
  }
  const ids = revisedTasks
    ? revisedTasks.flatMap((task) => (task.employeeId ? [task.employeeId] : []))
    : edit.employeeIds ?? card.people.map((row) => row.employeeId);
  const people: { employeeId: string; name: string }[] = [];
  for (const id of new Set(ids)) {
    const row = person(id);
    if (!row) return { ok: false, error: "Someone on that list cannot work on this job." };
    people.push({ employeeId: row.id, name: row.name });
  }
  const names = people.map((row) => row.name).join(", ");
  if (card.kind === "assign_people") {
    if (people.length === 0) return { ok: false, error: "Choose at least one person." };
    return { ok: true, card: { ...card, ...fresh, people, summary: `Assign ${names} to ${card.jobReference}.` } };
  }
  const title = edit.title ?? card.title;
  const reference = edit.reference ?? card.jobReference;
  if (title.length > 120) return { ok: false, error: "A job title can be 120 characters at most." };
  if (reference.length > 40) return { ok: false, error: "A job reference can be 40 characters at most." };
  const taken = catalog.references.find((item) => compact(item) === compact(reference));
  if (taken) return { ok: false, error: `Job ${taken} is already on file. Pick a different reference.` };
  return {
    ok: true,
    card: {
      ...card,
      ...fresh,
      title,
      jobReference: reference,
      billBasis: edit.billBasis ?? card.billBasis,
      people,
      ...(revisedTasks ? { tasks: revisedTasks } : {}),
      summary: `Open ${reference} (${title}) for ${card.clientName}.${names ? ` Assign ${names}.` : ""}${
        (revisedTasks ?? card.tasks)?.length ? ` ${taskCount((revisedTasks ?? card.tasks)!.length)}.` : ""
      }`,
    },
  };
}

/** Re-checks a saved card by id on Confirm, so two people with one name cannot swap places. */
export function recheckCard(
  card: Pick<JobCard, "kind" | "clientId" | "jobId" | "jobReference" | "people"> & Pick<Partial<JobCard>, "tasks">,
  catalog: { clients: OpsClient[]; people: OpsPerson[]; jobs: OpsJob[]; references: string[]; scopedClientId?: string | null; work?: OpsWork[] },
): string | null {
  if (catalog.scopedClientId && card.clientId !== catalog.scopedClientId) return "This jobs chat is limited to one client.";
  const client = catalog.clients.find((item) => item.id === card.clientId && !item.hidden);
  if (!client) return "That client is no longer on the Time tracking list.";
  if (card.kind === "create_job") {
    if (client.enabledServices && !client.enabledServices.includes("jobs")) return `Jobs is not turned on for ${client.name}.`;
    if (catalog.references.some((reference) => compact(reference) === compact(card.jobReference))) {
      return `Job reference ${card.jobReference} is already used. Ask again with a new reference.`;
    }
  } else {
    const job = catalog.jobs.find((item) => item.id === card.jobId);
    if (!job || job.status === "done" || job.clientId !== card.clientId) return "That job changed. Ask again.";
    if (
      card.kind === "edit_job" &&
      compact(card.jobReference) !== compact(job.reference) &&
      catalog.references.some((reference) => compact(reference) === compact(card.jobReference))
    ) {
      return `Job reference ${card.jobReference} is already used. Ask again with a new reference.`;
    }
  }
  for (const person of card.people) {
    const row = catalog.people.find((item) => item.id === person.employeeId);
    if (!row || row.active === false || (row.clientId && row.clientId !== card.clientId)) {
      return `${person.name} can no longer be assigned to this job.`;
    }
  }
  if (card.tasks && catalog.work) {
    const available = workOptions(client, catalog.work);
    const off = card.tasks.find((task) => !available.some((row) => row.code === task.activityCode));
    if (off) return `${off.activityName} is no longer turned on for ${client.name}.`;
  }
  return null;
}

export function jobChatGate(input: {
  canManage: boolean;
  actorId: string;
  threadOwnerId: string;
  status: string | null | undefined;
  expiresAt: string | null | undefined;
  now: number;
}): string | null {
  if (!input.canManage) return "Only someone who can manage jobs can confirm this.";
  if (input.actorId !== input.threadOwnerId) return "That chat belongs to someone else.";
  if (input.status !== "proposed") return "There is no job change waiting on that message.";
  if (!input.expiresAt || Date.parse(input.expiresAt) < input.now) return "That card expired. Ask again.";
  return null;
}

export function takeProposed(box: { status: string }) {
  if (box.status !== "proposed") return false;
  box.status = "applying";
  return true;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function namesOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

export function fold(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function compact(value: string) {
  return fold(value).replace(/\s+/g, "");
}

function codesOf(item: { name: string; code?: string; badgeCode?: string | null }) {
  return [item.code, item.badgeCode].filter((value): value is string => Boolean(value && value.trim()));
}

export function matchOne<T extends { name: string; code?: string; badgeCode?: string | null }>(
  list: T[],
  query: string,
  label: string,
): { ok: true; item: T } | { ok: false; error: string } {
  const needle = fold(query);
  if (!needle) return { ok: false, error: `Name a ${label}.` };
  const exact = list.filter((item) => fold(item.name) === needle);
  if (exact.length === 1) return { ok: true, item: exact[0]! };
  if (exact.length > 1) return { ok: false, error: `Several ${label}s are named "${query}". Be more specific.` };
  const byCode = list.filter((item) => codesOf(item).some((code) => fold(code) === needle || compact(code) === compact(query)));
  if (byCode.length === 1) return { ok: true, item: byCode[0]! };
  if (byCode.length > 1) return { ok: false, error: `Several ${label}s use "${query}". Be more specific.` };
  const first = list.filter((item) => fold(item.name).split(" ")[0] === needle);
  if (first.length === 1) return { ok: true, item: first[0]! };
  if (first.length > 1) {
    return { ok: false, error: `Several ${label}s are named "${query}". Use the full name from Time tracking.` };
  }
  const prefix = list.filter((item) => {
    const name = fold(item.name);
    return needle.length >= 3 && (name === needle || name.startsWith(`${needle} `));
  });
  if (prefix.length === 1) return { ok: true, item: prefix[0]! };
  if (prefix.length > 1) return { ok: false, error: `Several ${label}s match "${query}". Use the exact name.` };
  return { ok: false, error: `No ${label} named "${query}" is on the Time tracking list.` };
}

export function matchJob(jobs: OpsJob[], query: string): { ok: true; item: OpsJob } | { ok: false; error: string } {
  const needle = fold(query);
  const key = compact(query);
  if (!needle) return { ok: false, error: "Name the job reference to assign people to." };
  const byRef = jobs.filter((job) => fold(job.reference) === needle || compact(job.reference) === key);
  if (byRef.length === 1) return { ok: true, item: byRef[0]! };
  if (byRef.length > 1) return { ok: false, error: `Several jobs use reference "${query}".` };
  const byTitle = jobs.filter((job) => fold(job.title) === needle);
  if (byTitle.length === 1) return { ok: true, item: byTitle[0]! };
  if (byTitle.length > 1) return { ok: false, error: `Several jobs are titled "${query}". Use the job reference.` };
  return { ok: false, error: `No open job with reference "${query}".` };
}

export function matchPeople(people: OpsPerson[], names: string[]): { ok: true; people: { employeeId: string; name: string }[] } | { ok: false; error: string } {
  const out: { employeeId: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const hit = matchOne(people.filter((person) => person.active !== false), name, "person");
    if (!hit.ok) return hit;
    if (seen.has(hit.item.id)) continue;
    seen.add(hit.item.id);
    out.push({ employeeId: hit.item.id, name: hit.item.name });
  }
  return { ok: true, people: out };
}

export function parseCreateJob(
  args: Record<string, unknown>,
  catalog: {
    clients: OpsClient[];
    people: OpsPerson[];
    jobs?: OpsJob[];
    references?: string[];
    now: number;
    scopedClientId?: string | null;
    // What the person actually said. When set, nothing on the card may go beyond it.
    asked?: string;
    // When set, the card also carries the job's tasks.
    work?: OpsWork[];
  },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const clientName = text(args.client_name ?? args.clientName);
  let reference = text(args.reference);
  const title = text(args.title);
  const billText = text(args.bill_basis ?? args.billBasis);
  const peopleNames = namesOf(args.people);
  const asked = catalog.asked;
  if (!clientName && !catalog.scopedClientId) return { ok: false, error: "Name the Time tracking client for this job." };
  if (!reference && asked === undefined) return { ok: false, error: "Give the job a reference." };
  if (!title) return { ok: false, error: "Give the job a title." };
  if (reference.length > 40) return { ok: false, error: "A job reference can be 40 characters at most." };
  if (title.length > 120) return { ok: false, error: "A job title can be 120 characters at most." };
  let bill: string = "mixed";
  if (billText) {
    const basis = billBasisFrom(billText);
    if (!basis) return { ok: false, error: "Bill by must be time, pallet, carton, sku, or mixed." };
    bill = asked !== undefined && basis !== "mixed" && !billStated(asked, basis) ? "mixed" : basis;
  }
  const visible = catalog.clients.filter((client) => !client.hidden);
  const scoped = catalog.scopedClientId ? visible.filter((client) => client.id === catalog.scopedClientId) : visible;
  const client: ReturnType<typeof matchOne<OpsClient>> =
    !clientName && scoped[0] ? { ok: true, item: scoped[0] } : matchOne(scoped, clientName, "client");
  if (!client.ok) return client;
  if (catalog.scopedClientId && client.item.id !== catalog.scopedClientId) {
    return { ok: false, error: "This jobs chat is limited to one client." };
  }
  if (asked !== undefined && !catalog.scopedClientId) {
    const status = nameStatus(asked, visible, client.item);
    if (status === "missing") return { ok: false, error: `${client.item.name} was not named in the request. Ask which client this job is for.` };
    if (status === "ambiguous") return { ok: false, error: `More than one client fits for ${client.item.name}. Ask which one they mean.` };
  }
  if (client.item.enabledServices && !client.item.enabledServices.includes("jobs")) {
    return { ok: false, error: `Jobs is not turned on for ${client.item.name}.` };
  }
  const references = catalog.references ?? (catalog.jobs ?? []).map((job) => job.reference);
  if (asked !== undefined && reference && !compact(asked).includes(compact(reference))) {
    return { ok: false, error: `The reference ${reference} was not in the request. Leave reference empty so the app numbers the job.` };
  }
  if (!reference) reference = nextReference(client.item.code, client.item.name, references);
  const taken = references.find((item) => compact(item) === compact(reference));
  if (taken) return { ok: false, error: `Job ${taken} is already on file. Assign people to it, or pick a new reference.` };
  if (asked !== undefined && !titleFromRequest(title, asked, [client.item.name, client.item.code ?? "", reference, ...peopleNames])) {
    return { ok: false, error: "The request does not say what this job is for. Ask for a short description. Do not make up a title." };
  }
  const pool = catalog.people.filter((person) => !person.clientId || person.clientId === client.item.id);
  const crew =
    peopleNames.length === 0
      ? { ok: true as const, people: [] }
      : matchPeople(pool, peopleNames);
  if (!crew.ok) return crew;
  if (asked !== undefined) {
    const unnamed = checkPeopleNamed(asked, pool, crew.people);
    if (unnamed) return { ok: false, error: unnamed };
  }
  const now = catalog.now;
  let cardPeople = crew.people;
  let cardTasks: CardTask[] | undefined;
  let options: { code: string; name: string }[] | undefined;
  if (catalog.work) {
    options = workOptions(client.item, catalog.work);
    const built = buildTasks(args.tasks, {
      client: client.item,
      fallbackTitle: title,
      defaultPeople: peopleNames,
      pool,
      options,
      asked,
      ignore: [client.item.name, client.item.code ?? "", reference],
    });
    if (!built.ok) return built;
    cardTasks = built.tasks;
    cardPeople = [...crew.people, ...built.people.filter((person) => !crew.people.some((row) => row.employeeId === person.employeeId))];
  }
  const who = cardPeople.length ? ` Assign ${cardPeople.map((person) => person.name).join(", ")}.` : "";
  const work = cardTasks?.length ? ` ${taskCount(cardTasks.length)}.` : "";
  const notSaved = namesOf(args.not_saved).slice(0, 10);
  return {
    ok: true,
    card: {
      kind: "create_job",
      clientId: client.item.id,
      clientName: client.item.name,
      jobId: null,
      jobReference: reference,
      title,
      billBasis: bill,
      people: cardPeople,
      ...(cardTasks ? { tasks: cardTasks, workOptions: options ?? [] } : {}),
      summary: `Open ${reference} (${title}) for ${client.item.name}.${who}${work}`,
      ...(notSaved.length ? { notSaved } : {}),
      status: "proposed",
      proposedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + JOB_CHAT_TTL_MS).toISOString(),
      result: null,
      error: null,
    },
  };
}

export function parseAssignPeople(
  args: Record<string, unknown>,
  catalog: { jobs: OpsJob[]; people: OpsPerson[]; clients: OpsClient[]; now: number; scopedClientId?: string | null; asked?: string },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const reference = text(args.job_reference ?? args.jobReference ?? args.reference);
  const peopleNames = namesOf(args.people);
  if (!reference) return { ok: false, error: "Name the job reference to assign people to." };
  if (peopleNames.length === 0) return { ok: false, error: "Name at least one person to assign." };
  const open = catalog.jobs.filter((job) => job.status !== "done" && (!catalog.scopedClientId || job.clientId === catalog.scopedClientId));
  const job = matchJob(open, reference);
  if (!job.ok) return job;
  const found = job.item;
  const client = catalog.clients.find((item) => item.id === found.clientId);
  const pool = catalog.people.filter((person) => !person.clientId || person.clientId === found.clientId);
  const crew = matchPeople(pool, peopleNames);
  if (!crew.ok) return crew;
  if (catalog.asked !== undefined) {
    const unnamed = checkPeopleNamed(catalog.asked, pool, crew.people);
    if (unnamed) return { ok: false, error: unnamed };
  }
  const now = catalog.now;
  const notSaved = namesOf(args.not_saved).slice(0, 10);
  return {
    ok: true,
    card: {
      kind: "assign_people",
      ...(notSaved.length ? { notSaved } : {}),
      clientId: found.clientId,
      clientName: client?.name ?? "Client",
      jobId: found.id,
      jobReference: found.reference,
      title: found.title,
      billBasis: null,
      people: crew.people,
      summary: `Assign ${crew.people.map((person) => person.name).join(", ")} to ${found.reference}.`,
      status: "proposed",
      proposedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + JOB_CHAT_TTL_MS).toISOString(),
      result: null,
      error: null,
    },
  };
}
