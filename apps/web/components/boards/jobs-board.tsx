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
    assignees: { employeeId: string; name: string }[];
    tasks: JobTask[];
    openWorkerCount: number;
    openWorkers: string[];
    shipments: { id: string; reference: string; status: string }[];
    loads: { id: string; reference: string; status: string; palletCount: number | null; cartonCount: number | null }[];
    charges: { id: string; description: string; quantity: number; unit: string; amountCents: number; status: string }[];
  }[];
  clients: { id: string; name: string; code: string }[];
  people: { id: string; name: string }[];
};

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
          return (
            <article key={job.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
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
                </div>
              </div>
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
                    <li key={person.employeeId} className="flex items-center justify-between gap-2">
                      <span>{person.name}</span>
                      {canManageJobs(user?.role) ? (
                        <button
                          className="btn btn-ghost"
                          type="button"
                          onClick={() => void act(`/jobs/${job.id}/assignees/remove`, { employeeId: person.employeeId })}
                        >
                          Remove
                        </button>
                      ) : null}
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
                    people={people}
                    tasks={job.tasks}
                    services={job.enabledServices}
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
            </article>
          );
        })}
      </div>
    </div>
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
  closed,
  onAdd,
  onAddWork,
}: {
  people: { id: string; name: string }[];
  tasks: JobTask[];
  services: string[];
  closed: boolean;
  onAdd: (body: { title: string; assigneeId?: string; dueOn?: string; dependsOnId?: string }) => Promise<boolean>;
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
  const common = {
    ...(assigneeId ? { assigneeId } : {}),
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
  }

  return (
    <form
      className="mt-3 grid gap-3 md:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
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
        <Field label="Task">
          <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Count the pallets" />
        </Field>
      ) : null}
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
          <option value="">Unassigned</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>
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
        <button className="btn btn-ghost" type="submit">
          {kind ? `Add ${WORK_KINDS.find(([code]) => code === kind)?.[1].toLowerCase()}` : "Add task"}
        </button>
        {kind ? (
          <span className="ml-3 text-sm text-muted">This also opens the record on the {kind} board.</span>
        ) : null}
      </div>
    </form>
  );
}
