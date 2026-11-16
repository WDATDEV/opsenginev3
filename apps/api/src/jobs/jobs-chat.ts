export const JOB_CHAT_KIND = "jobs";
export const JOB_CHAT_TTL_MS = 15 * 60_000;
export const BILL_BASES = ["time", "pallet", "carton", "sku", "mixed"] as const;

export type OpsClient = { id: string; name: string; hidden?: boolean; enabledServices?: string[] };
export type OpsPerson = { id: string; name: string; clientId: string | null; active?: boolean };
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
  status: "proposed" | "applying" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  result: string | null;
  error: string | null;
};

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

export function matchOne<T extends { name: string }>(list: T[], query: string, label: string): { ok: true; item: T } | { ok: false; error: string } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { ok: false, error: `Name a ${label}.` };
  const exact = list.filter((item) => item.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, item: exact[0]! };
  if (exact.length > 1) return { ok: false, error: `Several ${label}s are named "${query}". Be more specific.` };
  const loose = list.filter((item) => item.name.trim().toLowerCase().includes(needle));
  if (loose.length === 1) return { ok: true, item: loose[0]! };
  if (loose.length > 1) return { ok: false, error: `Several ${label}s match "${query}". Use the exact name.` };
  return { ok: false, error: `No ${label} named "${query}" is on the Time tracking list.` };
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
  catalog: { clients: OpsClient[]; people: OpsPerson[]; now: number; scopedClientId?: string | null },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const clientName = text(args.client_name ?? args.clientName);
  const reference = text(args.reference);
  const title = text(args.title);
  const bill = text(args.bill_basis ?? args.billBasis).toLowerCase() || "mixed";
  const peopleNames = namesOf(args.people);
  if (!clientName) return { ok: false, error: "Name the Time tracking client for this job." };
  if (!reference) return { ok: false, error: "Give the job a reference." };
  if (!title) return { ok: false, error: "Give the job a title." };
  if (!BILL_BASES.includes(bill as (typeof BILL_BASES)[number])) {
    return { ok: false, error: "Bill by must be time, pallet, carton, sku, or mixed." };
  }
  const visible = catalog.clients.filter((client) => !client.hidden);
  const scoped = catalog.scopedClientId ? visible.filter((client) => client.id === catalog.scopedClientId) : visible;
  const client = matchOne(scoped, clientName, "client");
  if (!client.ok) return client;
  if (catalog.scopedClientId && client.item.id !== catalog.scopedClientId) {
    return { ok: false, error: "This jobs chat is limited to one client." };
  }
  if (client.item.enabledServices && !client.item.enabledServices.includes("jobs")) {
    return { ok: false, error: `Jobs is not turned on for ${client.item.name}.` };
  }
  const crew =
    peopleNames.length === 0
      ? { ok: true as const, people: [] }
      : matchPeople(
          catalog.people.filter((person) => !person.clientId || person.clientId === client.item.id),
          peopleNames,
        );
  if (!crew.ok) return crew;
  const now = catalog.now;
  const who = crew.people.length ? ` Assign ${crew.people.map((person) => person.name).join(", ")}.` : "";
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
  catalog: { jobs: OpsJob[]; people: OpsPerson[]; clients: OpsClient[]; now: number; scopedClientId?: string | null },
): { ok: true; card: JobCard } | { ok: false; error: string } {
  const reference = text(args.job_reference ?? args.jobReference ?? args.reference);
  const peopleNames = namesOf(args.people);
  if (!reference) return { ok: false, error: "Name the job reference to assign people to." };
  if (peopleNames.length === 0) return { ok: false, error: "Name at least one person to assign." };
  const open = catalog.jobs.filter((job) => job.status !== "done" && (!catalog.scopedClientId || job.clientId === catalog.scopedClientId));
  const named = open.map((job) => ({ ...job, name: job.reference }));
  const job = matchOne(named, reference, "job");
  if (!job.ok) return job;
  const found = job.item;
  const client = catalog.clients.find((item) => item.id === found.clientId);
  const crew = matchPeople(
    catalog.people.filter((person) => !person.clientId || person.clientId === found.clientId),
    peopleNames,
  );
  if (!crew.ok) return crew;
  const now = catalog.now;
  return {
    ok: true,
    card: {
      kind: "assign_people",
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
