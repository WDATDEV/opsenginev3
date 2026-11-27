"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { asCount, Avatar, Badge, CountInput, EmptyRow, Field, Flash, MoreButton, Notice, PageTitle, SearchBox, Segmented, SkeletonList, Stat, StatGrid, usePaged, useResource } from "@/components/ui";
import { ApiError, BILL_BASES, billBasisLabel, canApproveCharges, canManageJobs, money, post } from "@/lib/api";
import { JobsChat } from "@/components/boards/jobs-chat";

type JobTask = {
  id: string;
  title: string;
  details: string | null;
  status: string;
  dueOn: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dependsOnId: string | null;
  dependsOnTitle: string | null;
  blocked: boolean;
  startAt: string | null;
  activityCode: string | null;
  hourlyRateCents: number | null;
  activityName: string | null;
  started: boolean;
};

type JobBoard = {
  jobs: {
    id: string;
    reference: string;
    title: string;
    status: string;
    billBasis: string;
    clientId: string;
    clientName: string;
    clientCode: string;
    enabledServices: string[];
    laborMinutes: number;
    assignees: {
      employeeId: string;
      name: string;
      startAt: string | null;
      activityCode: string | null;
      activityName: string | null;
      started: boolean;
    }[];
    tasks: JobTask[];
    openWorkerCount: number;
    openWorkers: string[];
    shipments: { id: string; reference: string; status: string }[];
    loads: { id: string; reference: string; status: string; palletCount: number | null; cartonCount: number | null }[];
    charges: { id: string; description: string; quantity: number; unit: string; amountCents: number; status: string }[];
    hourlyRates: { activityCode: string | null; department: string | null; rateCents: number; label: string }[];
  }[];
  clients: { id: string; name: string; code: string }[];
  activities: { code: string; name: string; department: string; billable: boolean }[];
  people: { id: string; name: string; clientId: string | null }[];
};

const SERVICE_FOR_DEPARTMENT = ["receiving", "unloading", "packing", "picking", "sorting", "qc", "putaway", "returns", "replenishment", "cycle_count"];
const JOB_VIEWS = [
  ["open", "Open"],
  ["done", "Closed"],
  ["all", "All"],
] as const;

type JobView = (typeof JOB_VIEWS)[number][0];
type JobTab = "crew" | "tasks" | "charges";

function stamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function startNote(person: { startAt: string | null; activityName: string | null; started: boolean }) {
  if (!person.startAt) return "Starts when they tap Start at the check-in station";
  const what = person.activityName ? ` · ${person.activityName}` : "";
  return person.started
    ? `Started by the set time ${stamp(person.startAt)}${what}`
    : `Starts by itself at ${stamp(person.startAt)}${what}`;
}

function taskStartNote(task: { startAt: string | null; activityName: string | null; started: boolean }) {
  if (!task.startAt) return "No start time. They start it from the check-in station.";
  return task.started
    ? `Timer started by the set time ${stamp(task.startAt)}`
    : `Timer starts by itself at ${stamp(task.startAt)}`;
}

function billNote(basis: string) {
  if (basis === "time") return "Billed by time. The timer is the bill.";
  if (basis === "pallet") return "Billed by the pallet. The timer still records who worked, and that time stays off the bill.";
  if (basis === "carton") return "Billed by the carton. The timer still records who worked, and that time stays off the bill.";
  if (basis === "sku") return "Billed by each SKU. The timer still records who worked, and that time stays off the bill.";
  return `Billed by ${billBasisLabel(basis).toLowerCase()}. Time and the count can both land on the bill.`;
}

function hours(minutes: number) {
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (whole === 0) return `${rest} min`;
  return `${whole} h ${rest} min`;
}

type TaskLogEntry =
  | { kind: "work"; startedAt: string; endedAt: string | null; seconds: number; ended: string | null; addedByManager: boolean }
  | { kind: "pause"; startedAt: string; endedAt: string | null; seconds: number; reason: string }
  | { kind: "meal"; startedAt: string; endedAt: string | null; seconds: number };

type TaskLogData = {
  person: { id: string; name: string; badgeCode: string } | null;
  entries: TaskLogEntry[];
  totals: {
    workSeconds: number;
    pausedSeconds: number;
    mealSeconds: number;
    pauses: { reason: string; seconds: number }[];
    sessions: number;
    firstStart: string | null;
    lastEnd: string | null;
    now: "working" | "paused" | "meal" | null;
  };
};

function span(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "under 1 min" : "0 min";
  return hours(minutes);
}

function clock(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

const ENTRY_STYLE: Record<TaskLogEntry["kind"], { dot: string; label: string }> = {
  work: { dot: "bg-moss", label: "Working" },
  pause: { dot: "bg-clay", label: "Paused" },
  meal: { dot: "bg-black/30", label: "Meal break" },
};

/** One person's timeline on one task: when they worked, why and how long they paused, and meal breaks. */
function TaskLog({ jobId, taskId }: { jobId: string; taskId: string }) {
  const log = useResource<TaskLogData>(`/jobs/${jobId}/tasks/${taskId}/log`);
  if (log.loading && !log.data) return <div className="mt-2"><SkeletonList rows={2} /></div>;
  if (log.error) return <div className="mt-2"><Notice tone="bad">{log.error}</Notice></div>;
  const data = log.data;
  if (!data) return null;
  const { totals, entries } = data;
  const status =
    totals.now === "working" ? <Badge tone="ok" dot>Working now</Badge> : totals.now === "paused" ? <Badge tone="warn" dot>Paused now</Badge> : totals.now === "meal" ? <Badge dot>On a meal break</Badge> : null;

  return (
    <div className="mt-2 space-y-3 rounded-xl border border-black/10 bg-black/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {data.person?.name ?? "Unassigned"}’s log on this task
        </p>
        <div className="flex items-center gap-2">
          {status}
          <button className="text-xs text-moss underline" type="button" onClick={log.reload}>
            Refresh
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No time on this task yet. It shows here once they start it from the station.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
            <div className="rounded-lg bg-moss/10 px-2 py-2">
              <dt className="text-muted">Working</dt>
              <dd className="text-sm font-semibold">{span(totals.workSeconds)}</dd>
            </div>
            <div className="rounded-lg bg-clay/10 px-2 py-2">
              <dt className="text-muted">Paused</dt>
              <dd className="text-sm font-semibold">{span(totals.pausedSeconds)}</dd>
            </div>
            <div className="rounded-lg bg-black/[0.05] px-2 py-2">
              <dt className="text-muted">Meal breaks</dt>
              <dd className="text-sm font-semibold">{span(totals.mealSeconds)}</dd>
            </div>
            <div className="rounded-lg bg-black/[0.05] px-2 py-2">
              <dt className="text-muted">Work stretches</dt>
              <dd className="text-sm font-semibold">{totals.sessions}</dd>
            </div>
          </dl>
          {totals.pauses.length > 0 ? (
            <p className="text-xs text-muted">
              <span className="font-medium text-ink">Why they paused: </span>
              {totals.pauses.map((item) => `${item.reason} (${span(item.seconds)})`).join(" · ")}
            </p>
          ) : null}
          <ol className="relative space-y-2 border-l border-black/10 pl-4">
            {entries.map((entry, index) => (
              <li key={`${entry.kind}-${entry.startedAt}-${index}`} className="relative text-xs">
                <span className={`absolute -left-[1.3rem] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${ENTRY_STYLE[entry.kind].dot}`} />
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p>
                    <span className="font-semibold">{entry.kind === "pause" ? `Paused: ${entry.reason}` : ENTRY_STYLE[entry.kind].label}</span>
                    {entry.kind === "work" && entry.addedByManager ? <span className="text-muted"> · added by a manager</span> : null}
                  </p>
                  <p className="tabular-nums text-muted">{span(entry.seconds)}</p>
                </div>
                <p className="text-muted">
                  {stamp(entry.startedAt)} → {entry.endedAt ? clock(entry.endedAt) : "now"}
                  {entry.kind === "work" && entry.ended ? ` · ${entry.ended}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function TaskLogToggle({ jobId, taskId, person }: { jobId: string; taskId: string; person: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mt-1 block text-xs font-medium text-moss underline" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide work log" : `View ${person}’s work log`}
      </button>
      {open ? <TaskLog jobId={jobId} taskId={taskId} /> : null}
    </>
  );
}

export function JobsBoard({ client }: { client?: { id: string; name: string; code: string } }) {
  const board = useResource<JobBoard>("/jobs");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");
  const [billBasis, setBillBasis] = useState("mixed");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [jobTabs, setJobTabs] = useState<Record<string, JobTab>>({});
  const [view, setView] = useState<JobView>("open");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  async function act(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, body);
      setMessage(result.message ?? "Saved.");
      board.reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that job.");
      return false;
    }
  }

  const clients = (board.data?.clients ?? []).filter((item) => !client || item.id === client.id);
  const people = board.data?.people ?? [];
  const jobs = (board.data?.jobs ?? []).filter((job) => !client || job.clientId === client.id);
  const topOpenId = jobs.find((job) => job.status !== "done")?.id ?? null;

  function jobOpen(job: JobBoard["jobs"][number]) {
    if (job.id in expanded) return expanded[job.id];
    return job.status !== "done" && job.id === topOpenId;
  }

  function toggleJob(id: string, next: boolean) {
    setExpanded((current) => ({ ...current, [id]: next }));
  }

  const manageJobs = canManageJobs(user?.role);
  const approve = canApproveCharges(user?.role);
  const openList = jobs.filter((job) => job.status !== "done");
  const query = search.trim().toLowerCase();
  const list = jobs.filter(
    (job) =>
      (view === "all" || (view === "open") === (job.status !== "done")) &&
      (!query || `${job.reference} ${job.title} ${job.clientName} ${job.clientCode}`.toLowerCase().includes(query)),
  );
  const paged = usePaged(list, 15);
  const draftCents = jobs.reduce((sum, job) => sum + job.charges.filter((charge) => charge.status === "draft").reduce((total, charge) => total + charge.amountCents, 0), 0);

  return (
    <div>
      <PageTitle
        kicker="Jobs"
        title={client ? `Jobs for ${client.name}` : "Jobs"}
        detail="A job is the billable project. Build the crew and tasks here, and record the work on each department's board."
        actions={
          manageJobs ? (
            <button className="btn btn-primary" type="button" aria-expanded={creating} onClick={() => setCreating((value) => !value)}>
              {creating ? "Close" : "New job"}
            </button>
          ) : null
        }
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <StatGrid>
        <Stat label="Open jobs" value={openList.length} tone="ok" />
        <Stat label="Working now" value={openList.reduce((sum, job) => sum + job.openWorkerCount, 0)} />
        <Stat label="Labor on open jobs" value={hours(openList.reduce((sum, job) => sum + job.laborMinutes, 0))} />
        {manageJobs || approve ? (
          <Stat label="Charges to approve" value={money(draftCents)} tone={draftCents > 0 ? "warn" : undefined} />
        ) : (
          <Stat label="Closed jobs" value={jobs.length - openList.length} />
        )}
      </StatGrid>

      {manageJobs && creating ? (
        <form
          className="card page-enter mb-5 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const chosen = client?.id || clientId;
            if (!chosen) {
              setError("Choose a client.");
              return;
            }
            void act("/jobs", {
              clientId: chosen,
              reference,
              title,
              billBasis,
            }).then((ok) => {
              if (!ok) return;
              setReference("");
              setTitle("");
              setCreating(false);
            });
          }}
        >
          <h2 className="mb-3 font-semibold">New job</h2>
          <div className={`grid gap-3 sm:grid-cols-2 ${client ? "xl:grid-cols-[10rem_1fr_12rem_auto]" : "xl:grid-cols-[1fr_10rem_1fr_12rem_auto]"}`}>
            {client ? null : (
              <Field label="Client">
                <select className="field" required value={clientId} onChange={(event) => setClientId(event.target.value)}>
                  <option value="">Choose a client</option>
                  {clients.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Reference">
              <input className="field font-mono" required value={reference} onChange={(event) => setReference(event.target.value)} placeholder="IC-1002" />
            </Field>
            <Field label="Title">
              <input className="field" required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Five pallets inbound" />
            </Field>
            <Field label="Bill by">
              <select className="field" value={billBasis} onChange={(event) => setBillBasis(event.target.value)}>
                {BILL_BASES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button className="btn btn-primary w-full" type="submit">
                Open job
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented label="Show jobs" options={JOB_VIEWS} value={view} onChange={setView} />
            <SearchBox value={search} onChange={setSearch} label="Search jobs" placeholder="Search job or client" />
          </div>
          {board.loading && !board.data ? <SkeletonList rows={3} /> : null}
          {board.data && list.length === 0 ? (
            <div className="card">
              <EmptyRow title={query ? "No job matches that search" : view === "done" ? "No closed jobs" : "No open jobs"}>
                {query ? null : "Press New job, or ask the Jobs chat to open one."}
              </EmptyRow>
            </div>
          ) : null}
          <div className="space-y-3">
            {paged.shown.map((job) => {
              const drafted = job.charges.reduce((sum, charge) => sum + charge.amountCents, 0);
              const open = jobOpen(job);
              const closed = job.status === "done";
              const tab = jobTabs[job.id] ?? "crew";
              const openTasks = job.tasks.filter((task) => task.status !== "done").length;
              const pendingCharges = job.charges.filter((charge) => charge.status === "draft").length;
              const tabOptions = [
                ["crew", `Crew (${job.assignees.length})`],
                ["tasks", `Tasks (${openTasks})`],
                ["charges", pendingCharges ? `Charges (${pendingCharges} to approve)` : "Charges"],
              ] as const;
              const choices = startChoices(board.data?.activities ?? [], job.enabledServices);
              const available = people.filter(
                (person) =>
                  (!person.clientId || person.clientId === job.clientId) &&
                  !job.assignees.some((assigned) => assigned.employeeId === person.id),
              );
              return (
                <article key={job.id} className="card overflow-hidden">
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-black/[0.015] sm:px-5"
                    aria-expanded={open}
                    onClick={() => toggleJob(job.id, !open)}
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold">{job.title}</span>
                        <Badge tone={closed ? "neutral" : job.openWorkerCount ? "ok" : "warn"} dot>
                          {closed ? "Closed" : job.openWorkerCount ? "In progress" : "Open"}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-muted">
                        <span className="font-mono">{job.reference}</span> · {job.clientName} · {billBasisLabel(job.billBasis)}
                      </span>
                    </span>
                    <span className="flex flex-none items-start gap-3">
                      <span className="hidden text-right text-sm sm:block">
                        <span className="block font-medium tabular-nums">{hours(job.laborMinutes)}</span>
                        <span className="block max-w-[11rem] truncate text-xs text-muted">
                          {job.openWorkerCount === 0
                            ? "Nobody on it now"
                            : user?.role === "external_customer"
                              ? `${job.openWorkerCount} working now`
                              : job.openWorkers.join(", ")}
                        </span>
                      </span>
                      <svg aria-hidden="true" viewBox="0 0 20 20" className={`mt-1 h-4 w-4 flex-none text-muted transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 8 5 5 5-5" />
                      </svg>
                    </span>
                  </button>
                  {open ? (
                    <div className="border-t border-black/5 p-4 sm:px-5">
                      <p className="text-sm text-muted">{billNote(job.billBasis)}</p>
                      {job.shipments.length || job.loads.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {job.shipments.map((shipment) => (
                            <span key={shipment.id} className="badge">
                              Shipment {shipment.reference} · {shipment.status}
                            </span>
                          ))}
                          {job.loads.map((load) => (
                            <span key={load.id} className="badge">
                              Load {load.reference} · {load.status}
                              {load.palletCount != null ? ` · ${load.palletCount} pallets` : ""}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-3">
                        <Segmented label={`${job.reference} details`} options={tabOptions} value={tab} onChange={(next) => setJobTabs((current) => ({ ...current, [job.id]: next }))} />
                      </div>

                      {/* Tabs stay mounted so a half-filled form survives switching tabs. */}
                      <div className={`mt-3 ${tab === "crew" ? "" : "hidden"}`}>
                        {job.assignees.length === 0 ? <p className="text-sm text-muted">Nobody is assigned.</p> : null}
                        <ul className="divide-y divide-black/5">
                          {job.assignees.map((person) => (
                            <li key={person.employeeId} className="flex items-center gap-3 py-2">
                              <Avatar name={person.name} active={job.openWorkers.includes(person.name)} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{person.name}</span>
                                <span className="block truncate text-xs text-muted">{startNote(person)}</span>
                              </span>
                              {manageJobs ? (
                                <button className="btn btn-ghost btn-sm" type="button" onClick={() => void act(`/jobs/${job.id}/assignees/remove`, { employeeId: person.employeeId })}>
                                  Remove
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                        {manageJobs && people.length > 0 ? (
                          <AssignForm key={available.map((person) => person.id).join(",")} people={available} clientName={job.clientName} onAssign={(employeeId) => act(`/jobs/${job.id}/assignees`, { employeeId })} />
                        ) : null}
                      </div>

                      <div className={`mt-3 ${tab === "tasks" ? "" : "hidden"}`}>
                        {job.tasks.length === 0 ? <p className="text-sm text-muted">No tasks yet.</p> : null}
                        <ul className="divide-y divide-black/5">
                          {[...job.tasks].reverse().map((task) => (
                            <li key={task.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
                              <div className="min-w-0 flex-1 basis-64">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`font-medium ${task.status === "done" ? "text-muted line-through" : ""}`}>{task.title}</span>
                                  {task.status === "done" ? <Badge tone="ok">Done</Badge> : task.blocked ? <Badge tone="warn" dot>Waiting</Badge> : <Badge>Open</Badge>}
                                </div>
                                <p className="mt-0.5 text-xs text-muted">
                                  {[
                                    task.assigneeName ?? "Unassigned",
                                    task.dueOn ? `due ${task.dueOn}` : null,
                                    task.dependsOnTitle ? `after ${task.dependsOnTitle}` : null,
                                    task.hourlyRateCents != null ? `${money(task.hourlyRateCents)} / hour` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                                {task.status !== "done" && task.assigneeId ? <p className="text-xs text-muted">{taskStartNote(task)}</p> : null}
                                {manageJobs && task.status !== "done" && task.assigneeId && !closed ? (
                                  <StartTime
                                    key={`${task.id}-${task.startAt ?? "none"}-${task.started}`}
                                    activities={choices}
                                    current={task}
                                    onSave={(startAt, activityCode) =>
                                      act(`/jobs/${job.id}/tasks/${task.id}/start`, {
                                        startAt,
                                        ...(activityCode ? { activityCode } : {}),
                                      })
                                    }
                                  />
                                ) : null}
                                {task.assigneeId && task.assigneeName && user?.role !== "external_customer" ? (
                                  <TaskLogToggle jobId={job.id} taskId={task.id} person={task.assigneeName} />
                                ) : null}
                                {manageJobs && task.assigneeId && task.assigneeName ? (
                                  <AddTime person={task.assigneeName} activities={choices} activityCode={task.activityCode} onSave={(body) => act(`/jobs/${job.id}/tasks/${task.id}/time`, body)} />
                                ) : null}
                              </div>
                              {manageJobs && task.status !== "done" && !task.blocked ? (
                                <button className="btn btn-sm" type="button" onClick={() => void act(`/jobs/${job.id}/tasks/${task.id}/done`, {})}>
                                  Mark done
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                        {manageJobs ? (
                          <details className="mt-3 rounded-xl border border-black/10">
                            <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-moss">Add a task or floor work</summary>
                            <div className="border-t border-black/5 px-3 pb-3">
                              <TaskForm
                                people={job.assignees.map((person) => ({ id: person.employeeId, name: person.name }))}
                                tasks={job.tasks}
                                services={job.enabledServices}
                                activities={choices}
                                rates={job.hourlyRates ?? []}
                                closed={closed}
                                onAdd={(body) => act(`/jobs/${job.id}/tasks`, body)}
                                onAddWork={(body) => act(`/jobs/${job.id}/work`, body)}
                              />
                            </div>
                          </details>
                        ) : null}
                      </div>

                      <div className={`mt-3 ${tab === "charges" ? "" : "hidden"}`}>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm">
                            Total <span className="font-mono font-semibold tabular-nums">{money(drafted)}</span>
                          </p>
                          {manageJobs || approve ? (
                            <button className="btn btn-sm" type="button" onClick={() => void act(`/jobs/${job.id}/charges`, {})}>
                              Draft charges
                            </button>
                          ) : null}
                        </div>
                        {job.charges.length === 0 ? <p className="text-sm text-muted">No charges yet.</p> : null}
                        <ul className="divide-y divide-black/5 text-sm">
                          {job.charges.map((charge) => (
                            <li key={charge.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <span className="min-w-0 flex-1 basis-48">{charge.description}</span>
                              <span className="flex items-center gap-2">
                                <Badge tone={charge.status === "draft" ? "warn" : "ok"}>
                                  <span className="capitalize">{charge.status}</span>
                                </Badge>
                                <span className="font-mono font-medium tabular-nums">{money(charge.amountCents)}</span>
                                {approve && charge.status === "draft" ? (
                                  <button className="btn btn-sm" type="button" onClick={() => void act(`/billing/charges/${charge.id}/approve`, {})}>
                                    Approve
                                  </button>
                                ) : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {manageJobs && !closed ? (
                        <div className="mt-4 flex justify-end border-t border-black/5 pt-3">
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            onClick={() => {
                              if (window.confirm(`Close job ${job.reference}? Everyone must be paused first.`)) void act(`/jobs/${job.id}/done`, {});
                            }}
                          >
                            Close job
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          {paged.hidden > 0 ? <div className="card mt-3 overflow-hidden"><MoreButton hidden={paged.hidden} onClick={paged.more} /></div> : null}
        </div>
        <div className="xl:sticky xl:top-6">
          <JobsChat clientId={client?.id} people={people} onChanged={() => board.reload()} />
        </div>
      </div>
    </div>
  );
}

type StartChoice = { code: string; name: string; department: string };
type HourlyRate = { activityCode: string | null; department: string | null; rateCents: number; label: string };

function startChoices(
  activities: { code: string; name: string; department: string; billable: boolean }[],
  services: string[],
): StartChoice[] {
  return activities
    .filter((item) => item.billable && SERVICE_FOR_DEPARTMENT.includes(item.department) && services.includes(item.department))
    .map((item) => ({ code: item.code, name: item.name, department: item.department }));
}

function rateFor(rates: HourlyRate[], choice?: StartChoice | null, department?: string) {
  if (!choice && !department) return null;
  return (
    rates.find((rate) => choice && rate.activityCode === choice.code) ??
    rates.find((rate) => rate.department === (choice?.department ?? department) && !rate.activityCode) ??
    rates.find((rate) => rate.department === (choice?.department ?? department)) ??
    null
  );
}

function rateHint(rate: HourlyRate | null) {
  if (!rate) return "No hourly price is set for this kind of work yet. Add it on the client.";
  return `${rate.label} · ${money(rate.rateCents)} / hour. Draft charges use this price.`;
}

function toIso(local: string) {
  return new Date(local).toISOString();
}

function StartFields({
  activities,
  startAt,
  activityCode,
  onStartAt,
  onActivity,
}: {
  activities: StartChoice[];
  startAt: string;
  activityCode: string;
  onStartAt: (value: string) => void;
  onActivity: (value: string) => void;
}) {
  return (
    <>
      <Field label="Start time (optional)">
        <input className="field" type="datetime-local" value={startAt} onChange={(event) => onStartAt(event.target.value)} />
      </Field>
      {startAt ? (
        <Field label="Timer is for">
          <select className="field" value={activityCode} onChange={(event) => onActivity(event.target.value)}>
            <option value="">Choose the kind of work</option>
            {activities.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </>
  );
}

function StartTime({
  activities,
  current,
  onSave,
}: {
  activities: StartChoice[];
  current: { startAt: string | null; activityCode: string | null };
  onSave: (startAt: string | null, activityCode?: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState("");
  const [activityCode, setActivityCode] = useState(current.activityCode ?? activities[0]?.code ?? "");
  if (!open) {
    return (
      <button className="mt-1 text-xs text-moss underline" type="button" onClick={() => setOpen(true)}>
        {current.startAt ? "Change start time" : "Set a start time"}
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!startAt || !activityCode) return;
        void onSave(toIso(startAt), activityCode).then((ok) => {
          if (ok) setOpen(false);
        });
      }}
    >
      <StartFields activities={activities} startAt={startAt} activityCode={activityCode} onStartAt={setStartAt} onActivity={setActivityCode} />
      <button className="btn btn-ghost" type="submit" disabled={!startAt || !activityCode}>
        Save start
      </button>
      {current.startAt ? (
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() =>
            void onSave(null).then((ok) => {
              if (ok) setOpen(false);
            })
          }
        >
          No start time
        </button>
      ) : null}
      <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

// For a task the person did without running the timer: add the hours and the break by hand.
function AddTime({
  person,
  activities,
  activityCode,
  onSave,
}: {
  person: string;
  activities: StartChoice[];
  activityCode: string | null;
  onSave: (body: {
    startAt: string;
    endAt: string;
    breakStartAt?: string;
    breakEndAt?: string;
    activityCode?: string;
  }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [withBreak, setWithBreak] = useState(false);
  const [breakStartAt, setBreakStartAt] = useState("");
  const [breakEndAt, setBreakEndAt] = useState("");
  const [kind, setKind] = useState(activities[0]?.code ?? "");
  const needsKind = !activityCode;
  if (!open) {
    return (
      <button className="mt-1 block text-xs text-moss underline" type="button" onClick={() => setOpen(true)}>
        Add work time for {person}
      </button>
    );
  }
  const ready =
    Boolean(startAt && endAt) && (!withBreak || Boolean(breakStartAt && breakEndAt)) && (!needsKind || Boolean(kind));
  return (
    <form
      className="mt-2 grid gap-2 rounded-xl border border-black/10 bg-black/[0.02] p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void onSave({
          startAt: toIso(startAt),
          endAt: toIso(endAt),
          ...(withBreak ? { breakStartAt: toIso(breakStartAt), breakEndAt: toIso(breakEndAt) } : {}),
          ...(needsKind ? { activityCode: kind } : {}),
        }).then((ok) => {
          if (ok) {
            setOpen(false);
            setStartAt("");
            setEndAt("");
            setWithBreak(false);
            setBreakStartAt("");
            setBreakEndAt("");
          }
        });
      }}
    >
      <p className="text-xs text-muted sm:col-span-2">
        Use this when {person} did the work but never ran the timer. The time counts toward the job and the bill.
      </p>
      <Field label="Worked from">
        <input className="field" type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
      </Field>
      <Field label="Worked until">
        <input className="field" type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} />
      </Field>
      {needsKind ? (
        <Field label="Kind of work">
          <select className="field" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Choose the kind of work</option>
            {activities.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={withBreak} onChange={(event) => setWithBreak(event.target.checked)} />
        {person} took a break (it is taken out of the work time)
      </label>
      {withBreak ? (
        <>
          <Field label="Break from">
            <input className="field" type="datetime-local" value={breakStartAt} onChange={(event) => setBreakStartAt(event.target.value)} />
          </Field>
          <Field label="Break until">
            <input className="field" type="datetime-local" value={breakEndAt} onChange={(event) => setBreakEndAt(event.target.value)} />
          </Field>
        </>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn btn-primary" type="submit" disabled={!ready}>
          Add time
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AssignForm({
  people,
  clientName,
  onAssign,
}: {
  people: { id: string; name: string; clientId: string | null }[];
  clientName: string;
  onAssign: (employeeId: string) => Promise<boolean>;
}) {
  const own = people.filter((person) => person.clientId);
  const shared = people.filter((person) => !person.clientId);
  const [employeeId, setEmployeeId] = useState((own[0] ?? shared[0])?.id ?? "");
  const options = (list: typeof people) =>
    list.map((person) => (
      <option key={person.id} value={person.id}>
        {person.name}
      </option>
    ));
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!employeeId) return;
        void onAssign(employeeId);
      }}
    >
      <Field label="Assign someone">
        <select className="field" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          {people.length === 0 ? <option value="">Nobody else can be assigned</option> : null}
          {own.length > 0 ? <optgroup label={`${clientName} people`}>{options(own)}</optgroup> : null}
          {shared.length > 0 ? <optgroup label="Shared warehouse staff">{options(shared)}</optgroup> : null}
        </select>
      </Field>
      <button className="btn btn-ghost" type="submit" disabled={people.length === 0}>
        Assign
      </button>
      <p className="w-full text-xs text-muted">Set a start time on a task below to make its timer begin by itself.</p>
    </form>
  );
}

const WORK_KINDS = [
  ["receiving", "Receiving"],
  ["unloading", "Unloading"],
  ["packing", "Packing"],
  ["picking", "Picking"],
  ["sorting", "Sorting"],
] as const;

const CARRIERS = ["usps", "ups", "fedex", "dhl", "other"] as const;

function TaskForm({
  people,
  tasks,
  services,
  activities,
  rates,
  closed,
  onAdd,
  onAddWork,
}: {
  people: { id: string; name: string }[];
  activities: StartChoice[];
  rates: HourlyRate[];
  tasks: JobTask[];
  services: string[];
  closed: boolean;
  onAdd: (body: {
    title: string;
    assigneeId?: string;
    dueOn?: string;
    dependsOnId?: string;
    startAt?: string;
    activityCode?: string;
    hourlyRateCents?: number;
  }) => Promise<boolean>;
  onAddWork: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const kinds = WORK_KINDS.filter(([code]) => services.includes(code));
  const [kind, setKind] = useState("");
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [dependsOnId, setDependsOnId] = useState("");
  const [reference, setReference] = useState("");
  const [carrier, setCarrier] = useState<(typeof CARRIERS)[number]>("ups");
  const [expectedCartons, setExpectedCartons] = useState("0");
  const [loadKind, setLoadKind] = useState<"truck" | "container">("truck");
  const [dock, setDock] = useState("Dock 1");
  const [pallets, setPallets] = useState("0");
  const [cartons, setCartons] = useState("0");
  const [orders, setOrders] = useState("1");
  const [note, setNote] = useState("");
  const [units, setUnits] = useState("1");
  const [startAt, setStartAt] = useState("");
  const [hourlyDollars, setHourlyDollars] = useState("");
  const chosenRate = kind ? rateFor(rates, null, kind) : null;
  const hourlyCents = Math.round(Number(hourlyDollars) * 100);
  const hourlyReady = hourlyDollars.trim() !== "" && Number.isFinite(hourlyCents) && hourlyCents >= 0;
  const common = {
    ...(assigneeId ? { assigneeId } : {}),
    ...(assigneeId && startAt ? { startAt: toIso(startAt) } : {}),
    ...(kind === "" && hourlyReady ? { hourlyRateCents: hourlyCents } : {}),
    ...(dueOn ? { dueOn } : {}),
    ...(dependsOnId ? { dependsOnId } : {}),
  };

  function body(): Record<string, unknown> {
    if (kind === "receiving") return { kind, reference, carrier, expectedCartons: asCount(expectedCartons), ...common };
    if (kind === "unloading") {
      return { kind, reference, loadKind, dock, pallets: asCount(pallets), cartons: asCount(cartons), ...common };
    }
    if (kind === "packing") return { kind, orders: Math.max(1, asCount(orders, 1)), note, ...common };
    if (kind === "picking") return { kind, reference, units: Math.max(1, asCount(units, 1)), ...common };
    return { kind, reference, carrier, ...common };
  }

  function reset() {
    setTitle("");
    setDueOn("");
    setDependsOnId("");
    setReference("");
    setExpectedCartons("0");
    setPallets("0");
    setCartons("0");
    setOrders("1");
    setNote("");
    setUnits("1");
    setStartAt("");
    setHourlyDollars("");
  }

  return (
    <form
      className="mt-3 grid gap-3 md:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === "" && (!title.trim() || !hourlyReady)) return;
        const send = kind ? onAddWork(body()) : onAdd({ title, ...common });
        void send.then((ok) => {
          if (ok) reset();
        });
      }}
    >
      {kinds.length > 0 && !closed ? (
        <Field label="Type">
          <select className="field" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Task</option>
            {kinds.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {kind === "" ? (
        <>
          <Field label="Task">
            <input
              className="field"
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Count the pallets"
            />
          </Field>
          <Field label="Price per hour" hint="Draft charges for this task use this hourly price.">
            <div className="flex items-center gap-2">
              <span className="text-muted" aria-hidden="true">
                $
              </span>
              <CountInput decimal placeholder="0.00" value={hourlyDollars} onChange={setHourlyDollars} />
              <span className="shrink-0 text-sm text-muted">/ hour</span>
            </div>
          </Field>
        </>
      ) : (
        <p className="self-end text-xs text-muted md:col-span-2">{rateHint(chosenRate)}</p>
      )}
      {kind === "receiving" ? (
        <>
          <Field label="Shipment number">
            <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
          <Field label="Carrier">
            <select className="field" value={carrier} onChange={(event) => setCarrier(event.target.value as typeof carrier)}>
              {CARRIERS.map((item) => (
                <option key={item} value={item}>
                  {item.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cartons expected">
            <CountInput value={expectedCartons} onChange={setExpectedCartons} />
          </Field>
        </>
      ) : null}
      {kind === "unloading" ? (
        <>
          <Field label="Trailer or container">
            <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Trailer number" />
          </Field>
          <Field label="Kind">
            <select className="field" value={loadKind} onChange={(event) => setLoadKind(event.target.value as typeof loadKind)}>
              <option value="truck">Truck</option>
              <option value="container">Container</option>
            </select>
          </Field>
          <Field label="Dock">
            <input className="field" value={dock} onChange={(event) => setDock(event.target.value)} />
          </Field>
          <Field label="Pallets">
            <CountInput value={pallets} onChange={setPallets} />
          </Field>
          <Field label="Cartons">
            <CountInput value={cartons} onChange={setCartons} />
          </Field>
        </>
      ) : null}
      {kind === "packing" ? (
        <>
          <Field label="Orders to pack">
            <CountInput value={orders} onChange={setOrders} />
          </Field>
          <Field label="Note">
            <input className="field" value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </>
      ) : null}
      {kind === "picking" ? (
        <>
          <Field label="Batch">
            <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
          <Field label="Units to pick">
            <CountInput value={units} onChange={setUnits} />
          </Field>
        </>
      ) : null}
      {kind === "sorting" ? (
        <>
          <Field label="Bin code">
            <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
          <Field label="Carrier">
            <select className="field" value={carrier} onChange={(event) => setCarrier(event.target.value as typeof carrier)}>
              {CARRIERS.map((item) => (
                <option key={item} value={item}>
                  {item.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}
      <Field label="Assignee">
        <select className="field" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
          <option value="">{people.length === 0 ? "Add someone to the crew first" : "Unassigned"}</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>
      {assigneeId ? (
        <>
          <Field label="Start time (optional)">
            <input
              className="field"
              type="datetime-local"
              step={60}
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          </Field>
        </>
      ) : null}
      <Field label="Due">
        <input className="field" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
      </Field>
      <Field label="Depends on">
        <select className="field" value={dependsOnId} onChange={(event) => setDependsOnId(event.target.value)}>
          <option value="">Nothing</option>
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </Field>
      <div className="md:col-span-4">
        <button className="btn btn-ghost" type="submit" disabled={kind === "" && (!title.trim() || !hourlyReady)}>
          {kind ? `Add ${WORK_KINDS.find(([code]) => code === kind)?.[1].toLowerCase()}` : "Add task"}
        </button>
        {kind ? (
          <span className="ml-3 text-sm text-muted">
            {kind === "receiving" || kind === "unloading"
              ? `Adds a task. The live ${kind} work still happens on the ${kind} page, attached to this job.`
              : `Adds a task on this job. Record the work on the ${kind} page.`}
          </span>
        ) : null}
        {assigneeId ? (
          <p className="mt-2 text-xs text-muted">
            {startAt
              ? "The timer for this task begins by itself at that time, once the person is checked in."
              : "With no start time, the person starts this task from the floor phone and the timer begins then."}
          </p>
        ) : null}
      </div>
    </form>
  );
}
