"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManageJobs, money, post } from "@/lib/api";

type Client = {
  id: string;
  name: string;
  code: string;
  rates: { id: string; activityCode: string | null; unit: string; rateCents: number; label: string }[];
};

type Activities = {
  activities: { code: string; name: string; billable: boolean }[];
};

const UNITS = ["hour", "pallet", "carton", "unit", "sku", "flat"] as const;

export default function ClientsPage() {
  const clients = useResource<Client[]>("/clients");
  const jobs = useResource<Activities>("/jobs");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <PageTitle
        kicker="Clients"
        title="Each account keeps its own prices"
        detail="A rate belongs to one client. IceCartel can be billed by the hour and by the pallet. Jacob can use a different price for the same activity."
      />
      {clients.error ? <Notice tone="bad">{clients.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="space-y-4">
        {clients.data?.map((client) => (
          <ClientCard
            key={client.id}
            client={client}
            activities={jobs.data?.activities ?? []}
            manage={canManageJobs(user?.role)}
            onSaved={(text) => {
              setError(null);
              setMessage(text);
              clients.reload();
            }}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );
}

function ClientCard({
  client,
  activities,
  manage,
  onSaved,
  onError,
}: {
  client: Client;
  activities: { code: string; name: string }[];
  manage: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [activityCode, setActivityCode] = useState(activities[0]?.code ?? "unload_trailer");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("hour");
  const [dollars, setDollars] = useState("45");

  return (
    <article className="card p-4">
      <h2 className="text-xl font-semibold">
        {client.name} <span className="font-mono text-base text-muted">{client.code}</span>
      </h2>
      <ul className="mt-3 space-y-1 text-sm">
        {client.rates.length === 0 ? <li className="text-muted">No rates yet.</li> : null}
        {client.rates.map((rate) => (
          <li key={rate.id}>
            {rate.label} · {rate.activityCode ?? "any activity"} · {rate.unit} · {money(rate.rateCents)}
          </li>
        ))}
      </ul>
      {manage ? (
        <form
          className="mt-4 grid gap-3 border-t border-black/5 pt-4 md:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            const rateCents = Math.round(Number(dollars) * 100);
            void post<{ message: string }>(`/clients/${client.id}/rates`, {
              label,
              activityCode: unit === "flat" ? undefined : activityCode,
              unit,
              rateCents,
            })
              .then((result) => onSaved(result.message))
              .catch((err: unknown) => onError(err instanceof ApiError ? err.message : "Could not save that rate."));
          }}
        >
          <Field label="Label">
            <input className="field" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Unload labor" />
          </Field>
          <Field label="Activity">
            <select className="field" value={activityCode} onChange={(event) => setActivityCode(event.target.value)}>
              {activities.map((activity) => (
                <option key={activity.code} value={activity.code}>
                  {activity.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Unit">
            <select className="field" value={unit} onChange={(event) => setUnit(event.target.value as (typeof UNITS)[number])}>
              {UNITS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price (USD)">
            <input className="field" value={dollars} onChange={(event) => setDollars(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Save rate
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
