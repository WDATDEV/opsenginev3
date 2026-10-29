"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  devices: {
    code: string;
    label: string;
    kind: string;
    ownership: string;
    location: string;
    assignedTo: string | null;
    checkedOutTo: string | null;
  }[];
  events: {
    id: string;
    batchCode: string;
    sku: string;
    qty: number;
    via: string;
    pickedAt: string;
    employeeName: string;
    deviceCode: string;
  }[];
};

export default function PickingPage() {
  const board = useResource<Board>("/tracking/picking");
  const user = useSession();
  const [deviceCode, setDeviceCode] = useState("SCN-04");
  const [badge, setBadge] = useState("B-10443");
  const [batchCode, setBatchCode] = useState("BATCH-19");
  const [sku, setSku] = useState("SKU-TEE");
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await post<{ message: string }>("/tracking/picking", {
        deviceCode,
        badge,
        batchCode,
        sku,
        qty,
      });
      setMessage(result.message);
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that pick.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Picking"
        title="Scanner or handheld"
        detail="A personal scanner belongs to one picker. A shared handheld has to be checked out, or the picker badges at the scan."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {canManage(user?.role) ? (
          <form className="card space-y-3 p-4" onSubmit={submit}>
            <h2 className="font-semibold">Record a pick</h2>
            {message ? <Notice tone="ok">{message}</Notice> : null}
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Device">
              <select className="field" value={deviceCode} onChange={(event) => setDeviceCode(event.target.value)}>
                {board.data?.devices.map((device) => (
                  <option key={device.code} value={device.code}>
                    {device.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Badge, if this device is shared">
              <input className="field font-mono" value={badge} onChange={(event) => setBadge(event.target.value)} />
            </Field>
            <Field label="Batch">
              <input className="field" value={batchCode} onChange={(event) => setBatchCode(event.target.value)} />
            </Field>
            <Field label="SKU">
              <input className="field" value={sku} onChange={(event) => setSku(event.target.value)} />
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
          <div className="grid gap-3 sm:grid-cols-2">
            {board.data?.devices.map((device) => (
              <article key={device.code} className="card p-4">
                <p className="font-mono text-sm">{device.code}</p>
                <h3 className="font-semibold">{device.label}</h3>
                <p className="mt-2 text-sm capitalize">
                  {device.ownership === "personal" ? "Personal" : "Shared pool"} · {device.kind.replaceAll("_", " ")}
                </p>
                <p className="text-sm text-muted">
                  {device.assignedTo
                    ? `Assigned to ${device.assignedTo}`
                    : device.checkedOutTo
                      ? `Checked out to ${device.checkedOutTo}`
                      : "In the pool"}
                </p>
              </article>
            ))}
          </div>
          <div className="card p-4">
            <h2 className="font-semibold">Picks</h2>
            <ul className="mt-3 space-y-3">
              {board.data?.events.map((item) => (
                <li key={item.id} className="border-b border-black/5 pb-3 last:border-0">
                  <p>
                    {item.employeeName} picked {item.qty} × {item.sku} on {item.deviceCode}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {item.batchCode} · {item.via === "personal_device" ? "personal scanner" : "shared device"} ·{" "}
                    {when(item.pickedAt)}
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
