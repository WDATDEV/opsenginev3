"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  events: {
    id: string;
    batchCode: string;
    sku: string;
    qty: number;
    via: string;
    pickedAt: string;
    employeeName: string;
    deviceCode: string;
    clientId: string | null;
  }[];
};

export function PickingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/picking");
  const user = useSession();
  const [badge, setBadge] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>("/tracking/picking", {
        badge,
        batchCode,
        sku,
        qty,
        ...(client ? { clientId: client.id } : {}),
      });
      setMessage(result.message);
      setSku("");
      setQty(1);
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that pick.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Picking"
        title={client ? `Picking for ${client.name}` : "Who picked what"}
        detail={
          client
            ? `Who picked what for ${client.name}. Scan the picker's badge with each pick.`
            : "Scan the picker's badge with each pick."
        }
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {canManage(user?.role) ? (
          <form className="card space-y-3 p-4" onSubmit={submit}>
            <h2 className="font-semibold">Record a pick</h2>
            {message ? <Notice tone="ok">{message}</Notice> : null}
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Picker's badge">
              <input className="field font-mono" required value={badge} onChange={(event) => setBadge(event.target.value)} />
            </Field>
            <Field label="Batch">
              <input className="field" required value={batchCode} onChange={(event) => setBatchCode(event.target.value)} />
            </Field>
            <Field label="SKU">
              <input className="field" required value={sku} onChange={(event) => setSku(event.target.value)} />
            </Field>
            <Field label="Qty">
              <input className="field" type="number" min={1} value={qty} onChange={(event) => setQty(Number(event.target.value))} />
            </Field>
            <button className="btn btn-primary w-full" type="submit">
              Record pick
            </button>
          </form>
        ) : null}
        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="font-semibold">Picks</h2>
            <ul className="mt-3 space-y-3">
              {board.data?.events
                .filter((item) => !client || item.clientId === client.id)
                .map((item) => (
                <li key={item.id} className="border-b border-black/5 pb-3 last:border-0">
                  <p>
                    {item.employeeName} picked {item.qty} × {item.sku}
                    {item.deviceCode ? ` on ${item.deviceCode}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {item.batchCode} · {when(item.pickedAt)}
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
