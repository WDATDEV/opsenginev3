"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  stations: {
    code: string;
    label: string;
    location: string;
    loginMode: string;
    assignedTo: string | null;
    claimedBy: string | null;
  }[];
  events: {
    id: string;
    sentence: string;
    packedAt: string;
    units: number;
    clientId: string | null;
    warehanceRecorded: boolean;
  }[];
};

export function PackingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/packing");
  const user = useSession();
  const [orderNumber, setOrderNumber] = useState("WH-10021");
  const [deviceCode, setDeviceCode] = useState("PC-PACK-2");
  const [badge, setBadge] = useState("B-10442");
  const [units, setUnits] = useState(1);
  const [warehanceRecorded, setWarehanceRecorded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>("/tracking/packing", {
        orderNumber,
        deviceCode,
        badge,
        units,
        warehanceRecorded,
        ...(client ? { clientId: client.id } : {}),
      });
      setMessage(result.message);
      setOrderNumber("");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that pack.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Packing"
        title={client ? `Packing for ${client.name}` : "Who packed the order"}
        detail={
          client
            ? `Packs recorded here stay on ${client.name}. Shared station logins still need a badge.`
            : "Individual Warehance logins count as that person. Shared station logins need a badge. Ops Engine keeps the packer either way."
        }
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {canManage(user?.role) ? (
          <form className="card space-y-3 p-4" onSubmit={submit}>
            <h2 className="font-semibold">Record a pack</h2>
            {message ? <Notice tone="ok">{message}</Notice> : null}
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Order">
              <input className="field" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} />
            </Field>
            <Field label="Packing computer">
              <select className="field" value={deviceCode} onChange={(event) => setDeviceCode(event.target.value)}>
                {board.data?.stations.map((station) => (
                  <option key={station.code} value={station.code}>
                    {station.code} · {station.loginMode}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Badge">
              <input className="field font-mono" value={badge} onChange={(event) => setBadge(event.target.value)} />
            </Field>
            <Field label="Units">
              <input
                className="field"
                type="number"
                min={1}
                value={units}
                onChange={(event) => setUnits(Number(event.target.value))}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={warehanceRecorded}
                onChange={(event) => setWarehanceRecorded(event.target.checked)}
              />
              Warehance stored the packer
            </label>
            <button className="btn btn-primary w-full" type="submit">
              Finish pack
            </button>
          </form>
        ) : null}
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {board.data?.stations.map((station) => (
              <article key={station.code} className="card p-4">
                <p className="font-mono text-sm">{station.code}</p>
                <h3 className="text-lg font-semibold">{station.label}</h3>
                <p className="mt-2 text-sm">
                  {station.loginMode === "shared"
                    ? "Shared Warehance login"
                    : `Individual login${station.assignedTo ? ` · ${station.assignedTo}` : ""}`}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {station.claimedBy ? `${station.claimedBy} is at this bench` : "Nobody badged in"}
                </p>
              </article>
            ))}
          </div>
          <div className="card p-4">
            <h2 className="font-semibold">Packed orders</h2>
            <ul className="mt-3 space-y-3">
              {board.data?.events
                .filter((item) => !client || item.clientId === client.id)
                .map((item) => (
                <li key={item.id} className="border-b border-black/5 pb-3 last:border-0">
                  <p>{item.sentence}</p>
                  <p className="mt-1 text-xs text-muted">
                    {item.units} units · {when(item.packedAt)} ·{" "}
                    {item.warehanceRecorded ? "Warehance recorded" : "Warehance did not record"}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
