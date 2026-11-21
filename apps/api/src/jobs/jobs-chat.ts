export const JOB_CHAT_KIND = "jobs";
export const JOB_CHAT_TTL_MS = 15 * 60_000;
export const BILL_BASES = ["time", "pallet", "carton", "sku", "mixed"] as const;

export type OpsClient = { id: string; name: string; code?: string; hidden?: boolean; enabledServices?: string[] };
export type OpsPerson = { id: string; name: string; clientId: string | null; active?: boolean; badgeCode?: string | null };
export type OpsJob = { id: string; reference: string; title: string; clientId: string; status: string };

export type JobCardKind = "create_job" | "assign_people";

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
  status: "proposed" | "applying" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  result: string | null;
  error: string | null;
};

type HistoryRow = {
  role: string;
  content: string;
  jobChange?: Pick<JobCard, "jobReference" | "title" | "clientName" | "billBasis" | "people" | "status"> | null;
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
  return `${text}\n[App note: card for ${card.jobReference}, "${card.title}", ${card.clientName}, bill by ${card.billBasis ?? "unchanged"}, people: ${crew}. Status: ${card.status}.]`;
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

/** Re-checks a saved card by id on Confirm, so two people with one name cannot swap places. */
export function recheckCard(
  card: Pick<JobCard, "kind" | "clientId" | "jobId" | "jobReference" | "people">,
  catalog: { clients: OpsClient[]; people: OpsPerson[]; jobs: OpsJob[]; references: string[]; scopedClientId?: string | null },
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
  }
  for (const person of card.people) {
    const row = catalog.people.find((item) => item.id === person.employeeId);
    if (!row || row.active === false || (row.clientId && row.clientId !== card.clientId)) {
      return `${person.name} can no longer be assigned to this job.`;
    }
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
  const who = crew.people.length ? ` Assign ${crew.people.map((person) => person.name).join(", ")}.` : "";
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
      people: crew.people,
      summary: `Open ${reference} (${title}) for ${client.item.name}.${who}`,
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
