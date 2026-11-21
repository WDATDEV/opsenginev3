"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/shell";
import { EmptyRow, Field, Flash, Notice, PageTitle, SearchBox, SkeletonList, Spinner, useResource } from "@/components/ui";
import { ApiError, CLIENT_SERVICES, api, canManage, post } from "@/lib/api";

export type ClientRecord = {
  id: string;
  name: string;
  code: string;
  enabledServices: string[];
  rates: { id: string; activityCode: string | null; department: string | null; unit: string; rateCents: number; label: string }[];
};

const DEFAULT_SERVICES = ["jobs", "unloading", "people", "reports", "invoices"];

export function ClientDashboard() {
  const clients = useResource<ClientRecord[]>("/clients");
  const user = useSession();
  const manage = canManage(user?.role);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [services, setServices] = useState<string[]>(DEFAULT_SERVICES);
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");

  function toggleDraft(service: string) {
    setServices((current) => (current.includes(service) ? current.filter((item) => item !== service) : [...current, service]));
  }

  function sync() {
    setError(null);
    setMessage(null);
    setSyncing(true);
    void post<{ message?: string }>("/clients/warehance", {})
      .then((result) => {
        setMessage(result.message ?? "Warehance clients are up to date.");
        clients.reload();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load Warehance clients."))
      .finally(() => setSyncing(false));
  }

  function remove(client: ClientRecord) {
    if (!window.confirm(`Remove ${client.name} from Time tracking? They will leave this list. Sync from Warehance will not add them back.`)) return;
    setError(null);
    setMessage(null);
    void api<{ message?: string }>(`/clients/${client.id}`, { method: "DELETE" })
      .then((result) => {
        setMessage(result.message ?? "Removed.");
        clients.reload();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not remove that client."));
  }

  const query = search.trim().toLowerCase();
  const list = (clients.data ?? []).filter((client) => !query || `${client.name} ${client.code}`.toLowerCase().includes(query));

  return (
    <div>
      <PageTitle
        kicker="Time tracking"
        title="Clients"
        detail="Open a client to run their jobs, floor work, people, reports, and invoices."
        actions={
          manage ? (
            <>
              <button className="btn" type="button" disabled={syncing} onClick={sync}>
                {syncing ? <Spinner label="Syncing" /> : "Sync from Warehance"}
              </button>
              <button className="btn btn-primary" type="button" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>
                {adding ? "Close" : "Add client"}
              </button>
            </>
          ) : null
        }
      />
      {clients.error ? <div className="mb-4"><Notice tone="bad">{clients.error}</Notice></div> : null}
      <Flash message={message} error={error} />

      {manage && adding ? (
        <form
          className="card page-enter mb-5 space-y-4 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setMessage(null);
            void post<{ message?: string }>("/clients", { name, code, services })
              .then((result) => {
                setMessage(result.message ?? "Saved.");
                setName("");
                setCode("");
                setServices(DEFAULT_SERVICES);
                setAdding(false);
                clients.reload();
              })
              .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not add that client."));
          }}
        >
          <h2 className="font-semibold">New client</h2>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field label="Name">
              <input className="field" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Harbor Goods" />
            </Field>
            <Field label="Code">
              <input className="field font-mono" required value={code} onChange={(event) => setCode(event.target.value)} placeholder="HB" />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink/80">Services</legend>
            <div className="flex flex-wrap gap-2">
              {CLIENT_SERVICES.map(([service, label]) => {
                const on = services.includes(service);
                return (
                  <label
                    key={service}
                    className={`inline-flex min-h-10 cursor-pointer select-none items-center rounded-full border px-4 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-moss/40 ${
                      on ? "border-moss bg-moss text-paper" : "border-black/15 bg-white hover:border-moss"
                    }`}
                  >
                    <input className="sr-only" type="checkbox" checked={on} onChange={() => toggleDraft(service)} />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <button className="btn btn-primary" type="submit">
            Save client
          </button>
        </form>
      ) : null}

      {clients.loading && !clients.data ? <SkeletonList rows={4} /> : null}

      {clients.data?.length ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {list.length} of {clients.data.length} {clients.data.length === 1 ? "client" : "clients"}
          </p>
          <SearchBox value={search} onChange={setSearch} label="Search clients" placeholder="Search name or code" />
        </div>
      ) : null}

      {clients.data?.length === 0 ? (
        <div className="card">
          <EmptyRow title="No clients yet">Add a client, or press Sync from Warehance to bring yours in.</EmptyRow>
        </div>
      ) : null}
      {clients.data?.length && list.length === 0 ? (
        <div className="card">
          <EmptyRow title="No client matches that search" />
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((client) => {
          const on = CLIENT_SERVICES.filter(([service]) => client.enabledServices.includes(service));
          return (
            <article key={client.id} className="card card-hover flex flex-col p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-moss/10 font-mono text-xs font-semibold text-moss" aria-hidden="true">
                  {client.code.slice(0, 4)}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{client.name}</h2>
                  <p className="text-sm text-muted">
                    {on.length} {on.length === 1 ? "service" : "services"} on
                  </p>
                </div>
              </div>
              <div className="mt-3 flex min-h-7 flex-1 flex-wrap content-start gap-1.5">
                {on.length === 0 ? <span className="text-sm text-muted">No services turned on</span> : null}
                {on.slice(0, 5).map(([service, label]) => (
                  <span key={service} className="badge">
                    {label}
                  </span>
                ))}
                {on.length > 5 ? <span className="badge">+{on.length - 5}</span> : null}
              </div>
              <div className="mt-4 flex gap-2 border-t border-black/5 pt-3">
                <Link className="btn btn-primary btn-sm flex-1" href={`/clients/${client.id}`}>
                  Open
                </Link>
                {manage ? (
                  <button className="btn btn-ghost btn-danger btn-sm" type="button" aria-label={`Remove ${client.name}`} onClick={() => remove(client)}>
                    Remove
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
