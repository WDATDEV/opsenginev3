"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useReloadClientNav, useSession } from "@/components/shell";
import { Field, Notice, PageTitle, SkeletonList, Spinner, Switch, useResource } from "@/components/ui";
import { ApiError, CLIENT_SERVICES, canManage, canManageJobs, money, post } from "@/lib/api";
import type { ClientRecord } from "@/components/client-dashboard";

// The services a client is billed hourly for.
const HOURLY: [string, string][] = [
  ["receiving", "Receiving"],
  ["unloading", "Unloading"],
  ["packing", "Packing"],
  ["picking", "Picking"],
  ["sorting", "Sorting"],
];

// Prices that are not per hour. Each one is tied to the work billing already counts.
const OTHER_PRICES = [
  { id: "pallet", label: "Per pallet unloaded", unit: "pallet", activityCode: "unload_trailer" },
  { id: "carton", label: "Per carton unloaded", unit: "carton", activityCode: "unload_trailer" },
  { id: "sku", label: "Per SKU received", unit: "sku", activityCode: "receive_shipment" },
  { id: "received", label: "Per unit received", unit: "unit", activityCode: "receive_shipment" },
  { id: "packed", label: "Per unit packed", unit: "unit", activityCode: "pack_orders" },
  { id: "flat", label: "Flat fee per job", unit: "flat", activityCode: undefined },
] as const;

// Setup for one client: what each hour costs, and which services are on.
// It sits in the menu like Settings. Opening a client goes to Jobs instead (see ../page.tsx).
export default function ClientSettingsPage() {
  const params = useParams<{ id: string }>();
  const clients = useResource<ClientRecord[]>("/clients");
  const user = useSession();
  const reloadClientNav = useReloadClientNav();
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
      reloadClientNav();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that service.");
    }
  }

  if (clients.error) return <Notice tone="bad">{clients.error}</Notice>;
  if (!clients.data) return <SkeletonList rows={3} />;
  if (!client) return <Notice tone="bad">That client is not on your list.</Notice>;

  const saved = (text: string) => {
    setError(null);
    setMessage(text);
    clients.reload();
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageTitle
        kicker={client.name}
        title="Client settings"
        detail={`${client.code}: set what each hour of work costs, and turn services on or off.`}
      />
      <div className="space-y-3 empty:hidden">
        {message ? <Notice tone="ok">{message}</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </div>

      {/* Prices come first, since they are what people come here to set */}
      <HourlyPrices
        key={client.rates.map((rate) => `${rate.id}:${rate.rateCents}`).join("|")}
        client={client}
        manage={canManageJobs(user?.role)}
        onSaved={saved}
        onError={setError}
      />
      <OtherPrices client={client} manage={canManageJobs(user?.role)} onSaved={saved} onError={setError} />

      <section className="card p-5 sm:p-6">
        <h2 className="font-semibold">Services</h2>
        <p className="mt-1 text-sm text-muted">A service that is on shows in this client’s menu.</p>
        <ul className="mt-3 divide-y divide-black/5">
          {CLIENT_SERVICES.map(([service, label]) => {
            const on = client.enabledServices.includes(service);
            return (
              <li key={service} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{label}</p>
                  <p className="text-sm text-muted">{on ? "In the menu" : "Off"}</p>
                </div>
                <Switch label={on ? "On" : "Off"} checked={on} disabled={!canManage(user?.role)} onChange={(next) => void toggle(service, next)} />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

// One price per hour for each service. Hours worked in a service are charged at its price.
function HourlyPrices({
  client,
  manage,
  onSaved,
  onError,
}: {
  client: ClientRecord;
  manage: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const current = (service: string) => {
    const rate = client.rates.find((item) => item.department === service && item.unit === "hour");
    return rate ? (rate.rateCents / 100).toFixed(2) : "";
  };
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(HOURLY.map(([service]) => [service, current(service)])));
  const [saving, setSaving] = useState(false);

  async function save() {
    const rates: { department: string; rateCents: number | null }[] = [];
    for (const [service, label] of HOURLY) {
      const text = (values[service] ?? "").trim().replace(/^\$/, "");
      if (text === "") {
        rates.push({ department: service, rateCents: null });
        continue;
      }
      const dollars = Number(text);
      if (!Number.isFinite(dollars) || dollars < 0) {
        onError(`${label}: enter a price such as 45 or 45.50.`);
        return;
      }
      rates.push({ department: service, rateCents: Math.round(dollars * 100) });
    }
    setSaving(true);
    try {
      const result = await post<{ message: string }>(`/clients/${client.id}/rates/hourly`, { rates });
      onSaved(result.message);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save the prices.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <h2 className="font-semibold">Prices</h2>
      <p className="mt-1 text-sm text-muted">What {client.name} pays for each hour of work. Leave a service empty if it is not billed by the hour.</p>
      <div className="mt-4 divide-y divide-black/5">
        {HOURLY.map(([service, label]) => (
          <div key={service} className="flex items-center justify-between gap-3 py-3">
            <label htmlFor={`hourly-${service}`} className="font-medium">
              {label}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-muted" aria-hidden="true">
                $
              </span>
              <input
                id={`hourly-${service}`}
                className="field w-28 text-right"
                inputMode="decimal"
                placeholder="0.00"
                disabled={!manage}
                value={values[service] ?? ""}
                onChange={(event) => setValues({ ...values, [service]: event.target.value })}
              />
              <span className="w-12 text-sm text-muted">/ hour</span>
            </div>
          </div>
        ))}
      </div>
      {manage ? (
        <div className="mt-4 flex justify-end border-t border-black/5 pt-4">
          <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : null}
            Save prices
          </button>
        </div>
      ) : null}
    </section>
  );
}

// Prices counted by the pallet, carton, SKU or unit, or a flat fee. Kept out of the way.
function OtherPrices({
  client,
  manage,
  onSaved,
  onError,
}: {
  client: ClientRecord;
  manage: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [choice, setChoice] = useState<(typeof OTHER_PRICES)[number]["id"]>("pallet");
  const [label, setLabel] = useState("");
  const [dollars, setDollars] = useState("");
  const picked = OTHER_PRICES.find((item) => item.id === choice) ?? OTHER_PRICES[0];
  const others = client.rates.filter((rate) => !rate.department);

  return (
    <details className="card p-5 sm:p-6" open={others.length > 0}>
      <summary className="cursor-pointer select-none font-semibold">Other prices (per pallet, carton, unit, SKU, or a flat fee)</summary>
      <ul className="mt-3 space-y-1 text-sm">
        {others.length === 0 ? <li className="text-muted">None yet.</li> : null}
        {others.map((rate) => (
          <li key={rate.id}>
            {rate.label} · {rate.unit} · {money(rate.rateCents)}
          </li>
        ))}
      </ul>
      {manage ? (
        <form
          className="mt-4 grid gap-3 border-t border-black/5 pt-4 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            const rateCents = Math.round(Number(dollars) * 100);
            if (!Number.isFinite(rateCents) || rateCents < 0 || dollars.trim() === "") {
              onError("Enter a price such as 2.50.");
              return;
            }
            void post<{ message: string }>(`/clients/${client.id}/rates`, {
              label: label.trim() || picked.label,
              activityCode: picked.activityCode,
              unit: picked.unit,
              rateCents,
            })
              .then((result) => {
                setLabel("");
                setDollars("");
                onSaved(result.message);
              })
              .catch((err: unknown) => onError(err instanceof ApiError ? err.message : "Could not save that price."));
          }}
        >
          <Field label="Charged">
            <select className="field" value={choice} onChange={(event) => setChoice(event.target.value as typeof choice)}>
              {OTHER_PRICES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Shown on the invoice as">
            <input className="field" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={picked.label} />
          </Field>
          <Field label="Price (USD)">
            <input className="field" inputMode="decimal" value={dollars} onChange={(event) => setDollars(event.target.value)} placeholder="0.00" />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Save price
            </button>
          </div>
        </form>
      ) : null}
    </details>
  );
}
