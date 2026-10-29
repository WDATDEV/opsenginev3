"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, CLIENT_SERVICES, canManage, canManageJobs, canOpenService, money, post } from "@/lib/api";
import type { ClientRecord } from "@/components/client-dashboard";

const UNITS = ["hour", "pallet", "carton", "unit", "sku", "flat"] as const;

type Activity = { code: string; name: string; clientId: string | null };

export default function ClientHomePage() {
  const params = useParams<{ id: string }>();
  const clients = useResource<ClientRecord[]>("/clients");
  const catalog = useResource<Activity[]>("/tracking/activities");
  const user = useSession();
  const client = clients.data?.find((item) => item.id === params.id);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(service: string, enabled: boolean) {
    if (!client) return;
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(`/clients/${client.id}/services`, { service, enabled });
      setMessage(result.message ?? "Saved.");
      clients.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that service.");
    }
  }

  if (clients.error) return <Notice tone="bad">{clients.error}</Notice>;
  if (!client) return <p className="text-muted">{clients.data ? "That client is not on your list." : "Loading…"}</p>;

  return (
    <div>
      <PageTitle
        kicker="Warehance"
        title={client.name}
        detail={`${client.code} uses the services turned on here. View opens that client's own jobs, activities, equipment, people, and check-in.`}
      />
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <section className="card p-4">
        <h2 className="font-semibold">Services</h2>
        <ul className="mt-3 divide-y divide-black/5">
          {CLIENT_SERVICES.map(([service, label]) => {
            const on = client.enabledServices.includes(service);
            const open = on && canOpenService(user?.role, service);
            return (
              <li key={service} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{label}</p>
                  <p className="text-sm text-muted">{on ? "On for this client" : "Off"}</p>
                </div>
                <div className="flex items-center gap-2">
                  {open ? (
                    <Link className="btn btn-ghost" href={`/clients/${client.id}/${service}`}>
                      Open
                    </Link>
                  ) : null}
                  {canManage(user?.role) ? (
                    <button className="btn btn-primary" type="button" onClick={() => void toggle(service, !on)}>
                      {on ? "Turn off" : "Turn on"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <RateCard
        client={client}
        activities={(catalog.data ?? []).filter((item) => item.clientId === client.id)}
        manage={canManageJobs(user?.role)}
        onSaved={(text) => {
          setError(null);
          setMessage(text);
          clients.reload();
        }}
        onError={setError}
      />
    </div>
  );
}

function RateCard({
  client,
  activities,
  manage,
  onSaved,
  onError,
}: {
  client: ClientRecord;
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
    <article className="card mt-4 p-4">
      <h2 className="font-semibold">Prices</h2>
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
