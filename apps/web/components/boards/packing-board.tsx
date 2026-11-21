"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  events: {
    id: string;
    sentence: string;
    packedAt: string;
    units: number;
    clientId: string | null;
  }[];
};

export function PackingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/packing");
  const user = useSession();
  const [orderNumber, setOrderNumber] = useState("");
  const [badge, setBadge] = useState("");
  const [units, setUnits] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>("/tracking/packing", {
        orderNumber,
        badge,
        units,
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
            ? `Who packed which order for ${client.name}. Scan the packer's badge when the order is done.`
            : "Scan the packer's badge when the order is done."
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
              <input className="field" required value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} />
            </Field>
            <Field label="Packer's badge">
              <input className="field font-mono" required value={badge} onChange={(event) => setBadge(event.target.value)} />
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
            <button className="btn btn-primary w-full" type="submit">
              Finish pack
            </button>
          </form>
        ) : null}
        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="font-semibold">Packed orders</h2>
            <ul className="mt-3 space-y-3">
              {board.data?.events
                .filter((item) => !client || item.clientId === client.id)
                .map((item) => (
                <li key={item.id} className="border-b border-black/5 pb-3 last:border-0">
                  <p>{item.sentence}</p>
                  <p className="mt-1 text-xs text-muted">
                    {item.units} units · {when(item.packedAt)}
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
