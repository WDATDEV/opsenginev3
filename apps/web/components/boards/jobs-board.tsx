"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, BILL_BASES, billBasisLabel, canApproveCharges, canManageJobs, money, post } from "@/lib/api";

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
  people: { id: string; name: string }[];
};

const SERVICE_FOR_DEPARTMENT = ["receiving", "unloading", "packing", "picking", "sorting"];

function stamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function startNote(person: { startAt: string | null; activityName: string | null; started: boolean }) {
  if (!person.startAt) return "Starts when they tap the job on the floor phone";
  const what = person.activityName ? ` · ${person.activityName}` : "";
  return person.started
    ? `Started by the set time ${stamp(person.startAt)}${what}`
    : `Starts by itself at ${stamp(person.startAt)}${what}`;
}

function taskStartNote(task: { startAt: string | null; activityName: string | null; started: boolean }) {
  if (!task.startAt) return "No start time. They start it from the floor phone.";
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

  return (
    <div>
      <PageTitle
        kicker="Jobs"
        title={client ? `Jobs for ${client.name}` : "One job per client"}
        detail={
          client
            ? `${client.name} is already selected. Each job is a project. Say whether the bill uses time, a count, or both, then assign the crew.`
            : "Each job is a project for one client. Say whether the bill uses time, a count, or both, then assign the crew."
        }
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManageJobs(user?.role) ? (
        <form
          className="card mb-6 grid gap-3 p-4 md:grid-cols-4"
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
            });
          }}
        >
          {client ? null : (
            <Field label="Client">
              <select className="field" value={clientId} onChange={(event) => setClientId(event.target.value)}>
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
            <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="IC-1002" />
          </Field>
          <Field label="Title">
            <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Five pallets inbound" />
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
        </form>
      ) : null}
      <div className="space-y-4">
        {jobs.map((job) => {
          const drafted = job.charges.reduce((sum, charge) => sum + charge.amountCents, 0);
          const open = jobOpen(job);
          return (
            <article key={job.id} className="card p-4">
              <button
                type="button"
                className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
                aria-expanded={open}
                onClick={() => toggleJob(job.id, !open)}
              >
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted">
                    {job.clientName} · {job.clientCode}
                  </p>
                  <h2 className="text-xl font-semibold">{job.title}</h2>
                  <p className="font-mono text-sm text-muted">
                    {job.reference} · {job.status}
                  </p>
                  <p className="mt-1 text-sm">{billNote(job.billBasis)}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium">{hours(job.laborMinutes)} of labor</p>
                  <p className="text-muted">
                    {job.openWorkerCount === 0
                      ? "Nobody is on it now"
                      : user?.role === "external_customer"
                        ? `${job.openWorkerCount} working now`
                        : job.openWorkers.join(", ")}
                  </p>
                  <p className="mt-2 text-xs font-semibold text-moss">{open ? "Hide" : "Show"}</p>
                </div>
              </button>
              {open ? (
              <>
              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                {job.shipments.map((shipment) => (
                  <span key={shipment.id} className="rounded-full bg-black/5 px-3 py-1">
                    Shipment {shipment.reference} · {shipment.status}
                  </span>
                ))}
                {job.loads.map((load) => (
                  <span key={load.id} className="rounded-full bg-black/5 px-3 py-1">
                    Load {load.reference} · {load.status}
                    {load.palletCount != null ? ` · ${load.palletCount} pallets` : ""}
                  </span>
                ))}
              </div>
              <div className="mt-4 border-t border-black/5 pt-3">
                <h3 className="mb-2 font-medium">Crew</h3>
                {job.assignees.length === 0 ? <p className="text-sm text-muted">Nobody is assigned.</p> : null}
                <ul className="space-y-2 text-sm">
                  {job.assignees.map((person) => (
                    <li key={person.employeeId}>
                      <div className="flex items-center justify-between gap-2">
                        <span>
                          {person.name}
                          <span className="block text-xs text-muted">{startNote(person)}</span>
                        </span>
                        {canManageJobs(user?.role) ? (
                          <button
                            className="btn btn-ghost"
                            type="button"
                            onClick={() => void act(`/jobs/${job.id}/assignees/remove`, { employeeId: person.employeeId })}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {canManageJobs(user?.role) && people.length > 0 ? (
                  <AssignForm
                    key={people
                      .filter((person) => !job.assignees.some((assigned) => assigned.employeeId === person.id))
                      .map((person) => person.id)
                      .join(",")}
                    people={people.filter((person) => !job.assignees.some((assigned) => assigned.employeeId === person.id))}
                    onAssign={(employeeId) => act(`/jobs/${job.id}/assignees`, { employeeId })}
                  />
                ) : null}
              </div>
              <div className="mt-4 border-t border-black/5 pt-3">
                <h3 className="mb-2 font-medium">Tasks</h3>
                {job.tasks.length === 0 ? <p className="text-sm text-muted">No tasks yet.</p> : null}
                <ul className="space-y-2 text-sm">
                  {[...job.tasks].reverse().map((task) => (
                    <li key={task.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {task.title}
                        <span className="text-muted">
                          {" "}
                          · {task.status}
                          {task.assigneeName ? ` · ${task.assigneeName}` : ""}
                          {task.dueOn ? ` · due ${task.dueOn}` : ""}
                          {task.dependsOnTitle ? ` · after ${task.dependsOnTitle}` : ""}
                          {task.blocked ? " · waiting" : ""}
                        </span>
                        {task.status !== "done" && task.assigneeId ? (
                          <span className="block text-xs text-muted">{taskStartNote(task)}</span>
                        ) : null}
                        {canManageJobs(user?.role) && task.status !== "done" && task.assigneeId && job.status !== "done" ? (
                          <StartTime
                            key={`${task.id}-${task.startAt ?? "none"}-${task.started}`}
                            activities={startChoices(board.data?.activities ?? [], job.enabledServices)}
                            current={task}
                            onSave={(startAt, activityCode) =>
                              act(`/jobs/${job.id}/tasks/${task.id}/start`, {
                                startAt,
                                ...(activityCode ? { activityCode } : {}),
                              })
                            }
                          />
                        ) : null}
                        {canManageJobs(user?.role) && task.assigneeId && task.assigneeName ? (
                          <AddTime
                            person={task.assigneeName}
                            activities={startChoices(board.data?.activities ?? [], job.enabledServices)}
                            activityCode={task.activityCode}
                            onSave={(body) => act(`/jobs/${job.id}/tasks/${task.id}/time`, body)}
                          />
                        ) : null}
                      </span>
                      {canManageJobs(user?.role) && task.status !== "done" && !task.blocked ? (
                        <button className="btn btn-ghost" type="button" onClick={() => void act(`/jobs/${job.id}/tasks/${task.id}/done`, {})}>
                          Mark done
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {canManageJobs(user?.role) ? (
                  <TaskForm
                    people={job.assignees.map((person) => ({ id: person.employeeId, name: person.name }))}
                    tasks={job.tasks}
                    services={job.enabledServices}
                    activities={startChoices(board.data?.activities ?? [], job.enabledServices)}
                    rates={job.hourlyRates ?? []}
                    closed={job.status === "done"}
                    onAdd={(body) => act(`/jobs/${job.id}/tasks`, body)}
                    onAddWork={(body) => act(`/jobs/${job.id}/work`, body)}
                  />
                ) : null}
              </div>
              <div className="mt-4 border-t border-black/5 pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">Charges · {money(drafted)}</h3>
                  <div className="flex gap-2">
                    {canManageJobs(user?.role) || canApproveCharges(user?.role) ? (
                      <button className="btn btn-ghost" type="button" onClick={() => void act(`/jobs/${job.id}/charges`, {})}>
                        Draft charges
                      </button>
                    ) : null}
                    {canManageJobs(user?.role) && job.status !== "done" ? (
                      <button className="btn btn-ghost" type="button" onClick={() => void act(`/jobs/${job.id}/done`, {})}>
                        Close job
                      </button>
                    ) : null}
                  </div>
                </div>
                {job.charges.length === 0 ? <p className="text-sm text-muted">No charges yet.</p> : null}
                <ul className="space-y-2 text-sm">
                  {job.charges.map((charge) => (
                    <li key={charge.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {charge.description}
                        <span className="text-muted"> · {charge.status}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{money(charge.amountCents)}</span>
                        {canApproveCharges(user?.role) && charge.status === "draft" ? (
                          <button className="btn btn-ghost" type="button" onClick={() => void act(`/billing/charges/${charge.id}/approve`, {})}>
                            Approve
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              </>
              ) : null}
            </article>
          );
        })}
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
  onAssign,
}: {
  people: { id: string; name: string }[];
  onAssign: (employeeId: string) => Promise<boolean>;
}) {
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? "");
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
          {people.length === 0 ? <option value="">Everyone on this job is already assigned</option> : null}
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
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
  const [expectedCartons, setExpectedCartons] = useState(0);
  const [loadKind, setLoadKind] = useState<"truck" | "container">("truck");
  const [dock, setDock] = useState("Dock 1");
  const [pallets, setPallets] = useState(0);
  const [cartons, setCartons] = useState(0);
  const [orders, setOrders] = useState(1);
  const [note, setNote] = useState("");
  const [units, setUnits] = useState(1);
  const [startAt, setStartAt] = useState("");
  const [activityCode, setActivityCode] = useState(activities[0]?.code ?? "");
  const needsActivity = kind === "";
  const chosenActivity = activities.find((item) => item.code === activityCode) ?? activities[0] ?? null;
  const chosenRate = rateFor(rates, kind === "" ? chosenActivity : null, kind || undefined);
  const common = {
    ...(assigneeId ? { assigneeId } : {}),
    ...(assigneeId && startAt ? { startAt: toIso(startAt) } : {}),
    ...(kind === "" && activityCode ? { activityCode } : {}),
    ...(dueOn ? { dueOn } : {}),
    ...(dependsOnId ? { dependsOnId } : {}),
  };

  function body(): Record<string, unknown> {
    if (kind === "receiving") return { kind, reference, carrier, expectedCartons, ...common };
    if (kind === "unloading") return { kind, reference, loadKind, dock, pallets, cartons, ...common };
    if (kind === "packing") return { kind, orders, note, ...common };
    if (kind === "picking") return { kind, reference, units, ...common };
    return { kind, reference, carrier, ...common };
  }

  function reset() {
    setTitle("");
    setDueOn("");
    setDependsOnId("");
    setReference("");
    setExpectedCartons(0);
    setPallets(0);
    setCartons(0);
    setOrders(1);
    setNote("");
    setUnits(1);
    setStartAt("");
  }

  return (
    <form
      className="mt-3 grid gap-3 md:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (needsActivity && !activityCode) return;
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
          <Field label="Kind of work" hint={rateHint(chosenRate)}>
            <select className="field" value={activityCode} onChange={(event) => setActivityCode(event.target.value)}>
              <option value="">Choose the kind of work</option>
              {activities.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
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
            <input className="field" type="number" min={0} value={expectedCartons} onChange={(event) => setExpectedCartons(Number(event.target.value))} />
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
            <input className="field" type="number" min={0} value={pallets} onChange={(event) => setPallets(Number(event.target.value))} />
          </Field>
          <Field label="Cartons">
            <input className="field" type="number" min={0} value={cartons} onChange={(event) => setCartons(Number(event.target.value))} />
          </Field>
        </>
      ) : null}
      {kind === "packing" ? (
        <>
          <Field label="Orders to pack">
            <input className="field" type="number" min={1} value={orders} onChange={(event) => setOrders(Number(event.target.value))} />
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
            <input className="field" type="number" min={1} value={units} onChange={(event) => setUnits(Number(event.target.value))} />
          </Field>
        </>
      ) : null}
      {kind === "sorting" ? (
        <>
          <Field label="Gaylord code">
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
        <button className="btn btn-ghost" type="submit" disabled={needsActivity && !activityCode}>
          {kind ? `Add ${WORK_KINDS.find(([code]) => code === kind)?.[1].toLowerCase()}` : "Add task"}
        </button>
        {kind ? (
          <span className="ml-3 text-sm text-muted">This also opens the record on the {kind} board.</span>
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
