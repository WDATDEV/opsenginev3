"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, CLIENT_SERVICES, canManage, post } from "@/lib/api";

export type ClientRecord = {
  id: string;
  name: string;
  code: string;
  enabledServices: string[];
  rates: { id: string; activityCode: string | null; unit: string; rateCents: number; label: string }[];
};

export function ClientDashboard() {
  const clients = useResource<ClientRecord[]>("/clients");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [services, setServices] = useState<string[]>(["jobs"]);

  function toggleDraft(service: string) {
    setServices((current) => (current.includes(service) ? current.filter((item) => item !== service) : [...current, service]));
  }

  return (
    <div>
      <PageTitle
        kicker="Warehance"
        title="Clients"
        detail="Add a client once, then view them. The menu switches to that client's active services. Main menu brings this list back."
      />
      {clients.error ? <Notice tone="bad">{clients.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManage(user?.role) ? (
        <form
          className="card mb-6 grid gap-3 p-4 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setMessage(null);
            void post<{ message?: string }>("/clients", { name, code, services })
              .then((result) => {
                setMessage(result.message ?? "Saved.");
                setName("");
                setCode("");
                setServices(["jobs"]);
                clients.reload();
              })
              .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not add that client."));
          }}
        >
          <Field label="Name">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Harbor Goods" />
          </Field>
          <Field label="Code">
            <input className="field font-mono" value={code} onChange={(event) => setCode(event.target.value)} placeholder="HB" />
          </Field>
          <div className="md:col-span-3">
            <p className="mb-2 text-sm text-muted">Services</p>
            <div className="flex flex-wrap gap-3">
              {CLIENT_SERVICES.map(([service, label]) => (
                <label key={service} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={services.includes(service)} onChange={() => toggleDraft(service)} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <button className="btn btn-primary" type="submit">
              Add client
            </button>
          </div>
        </form>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {clients.data?.length === 0 ? <div className="card p-6 text-muted">No clients yet.</div> : null}
        {clients.data?.map((client) => (
            <article key={client.id} className="card p-4">
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">{client.code}</p>
              <h2 className="text-xl font-semibold">{client.name}</h2>
              <p className="mt-2 text-sm text-muted">
                {client.enabledServices.length === 0
                  ? "No services turned on"
                  : CLIENT_SERVICES.filter(([service]) => client.enabledServices.includes(service))
                      .map(([, label]) => label)
                      .join(" · ")}
              </p>
              <Link className="btn btn-ghost mt-3" href={`/clients/${client.id}`}>
                View
              </Link>
            </article>
        ))}
      </div>
    </div>
  );
}
