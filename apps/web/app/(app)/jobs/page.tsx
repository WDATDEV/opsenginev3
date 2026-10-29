"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canApproveCharges, canManageJobs, money, post } from "@/lib/api";

type JobBoard = {
  jobs: {
    id: string;
    reference: string;
    title: string;
    status: string;
    clientId: string;
    clientName: string;
    clientCode: string;
    laborMinutes: number;
    openWorkerCount: number;
    openWorkers: string[];
    shipments: { id: string; reference: string; status: string }[];
    loads: { id: string; reference: string; status: string; palletCount: number | null; cartonCount: number | null }[];
    charges: { id: string; description: string; quantity: number; unit: string; amountCents: number; status: string }[];
  }[];
  clients: { id: string; name: string; code: string }[];
};

function hours(minutes: number) {
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (whole === 0) return `${rest} min`;
  return `${whole} h ${rest} min`;
}

export default function JobsPage() {
  const board = useResource<JobBoard>("/jobs");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");

  async function act(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, body);
      setMessage(result.message ?? "Saved.");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that job.");
    }
  }

  const clients = board.data?.clients ?? [];

  return (
    <div>
      <PageTitle
        kicker="Jobs"
        title="One job per client"
        detail="IceCartel and Jacob share this system. Each job belongs to one client, and a manager only opens the clients on their login."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManageJobs(user?.role) ? (
        <form
          className="card mb-6 grid gap-3 p-4 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!clientId) {
              setError("Choose a client.");
              return;
            }
            void act("/jobs", {
              clientId,
              reference,
              title,
            });
          }}
        >
          <Field label="Client">
            <select className="field" value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">Choose a client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reference">
            <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="IC-1002" />
          </Field>
          <Field label="Title">
            <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Five pallets inbound" />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Open job
            </button>
          </div>
        </form>
      ) : null}
      <div className="space-y-4">
        {board.data?.jobs.map((job) => {
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
