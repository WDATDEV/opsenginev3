"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Shipment = {
  id: string;
  reference: string;
  carrier: string;
  status: string;
  expectedCartons: number;
  receivedCartons: number;
  clientId?: string | null;
  clientName?: string | null;
  jobReference?: string | null;
  workers: { name: string; role: string; active: boolean; joinedAt: string }[];
  lines: {
    id: string;
    sku: string;
    expectedQty: number;
    receivedQty: number;
    variance: number;
    employeeName: string;
    recordedAt: string;
  }[];
};

type JobOption = { id: string; reference: string; title: string; clientId: string; clientName: string; status: string };

export function ReceivingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Shipment[]>("/tracking/receiving");
  const jobs = useResource<{ jobs: JobOption[] }>("/jobs");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [carrier, setCarrier] = useState("XPO");
  const [expected, setExpected] = useState(10);
  const [jobId, setJobId] = useState("");

  async function act(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, body);
      setMessage(result.message ?? "Saved.");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update receiving.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Receiving"
        title={client ? `Receiving for ${client.name}` : "More than one person on a shipment"}
        detail={
          client
            ? `Shipments here belong to ${client.name}. Anyone clocked in can join an open shipment.`
            : "Anyone clocked in can join an open shipment. Each count stays with the person who entered it, even when the times overlap."
        }
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManage(user?.role) ? (
        <form
          className="card mb-6 grid gap-3 p-4 md:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            const openJobs = (jobs.data?.jobs ?? []).filter((job) => job.status !== "done" && (!client || job.clientId === client.id));
            void act("/tracking/receiving", {
              reference,
              jobId: jobId || openJobs[0]?.id,
              carrier,
              expectedCartons: expected,
            });
          }}
        >
          <Field label="Shipment">
            <input className="field" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="ASN-4402" />
          </Field>
          <Field label="Job">
            <select className="field" value={jobId} onChange={(event) => setJobId(event.target.value)}>
              {(jobs.data?.jobs ?? [])
                .filter((job) => job.status !== "done" && (!client || job.clientId === client.id))
                .map((job) => (
                  <option key={job.id} value={job.id}>
                    {client ? job.reference : `${job.clientName} · ${job.reference}`}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Carrier">
            <input className="field" value={carrier} onChange={(event) => setCarrier(event.target.value)} />
          </Field>
          <Field label="Expected units">
            <input className="field" type="number" min={0} value={expected} onChange={(event) => setExpected(Number(event.target.value))} />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Open shipment
            </button>
          </div>
        </form>
      ) : null}
      <div className="space-y-4">
        {board.data
          ?.filter((shipment) => !client || shipment.clientId === client.id)
          .map((shipment) => (
          <ShipmentCard key={shipment.id} shipment={shipment} manage={canManage(user?.role)} onAct={act} />
        ))}
      </div>
    </div>
  );
}

function ShipmentCard({
  shipment,
  manage,
  onAct,
}: {
  shipment: Shipment;
  manage: boolean;
  onAct: (path: string, body: unknown) => Promise<void>;
}) {
  const [badge, setBadge] = useState("B-10446");
  const [sku, setSku] = useState("SKU-HAT");
  const [expectedQty, setExpectedQty] = useState(4);
  const [receivedQty, setReceivedQty] = useState(4);

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm">{shipment.reference}</p>
          <h2 className="text-xl font-semibold capitalize">{shipment.status}</h2>
          <p className="text-sm text-muted">
            {shipment.clientName ? `${shipment.clientName} · ` : ""}
            {shipment.jobReference ? `${shipment.jobReference} · ` : ""}
            {shipment.carrier} · {shipment.receivedCartons} received / {shipment.expectedCartons} expected
          </p>
        </div>
        {manage && shipment.status !== "closed" ? (
          <button className="btn btn-ghost" type="button" onClick={() => onAct(`/tracking/receiving/${shipment.id}/close`, {})}>
            Close shipment
          </button>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {shipment.workers.filter((worker) => worker.active).map((worker) => (
          <span key={worker.name} className="rounded-full bg-moss/10 px-3 py-1 text-sm text-moss">
            {worker.name} · {worker.role} since {when(worker.joinedAt)}
          </span>
        ))}
        {shipment.workers.filter((worker) => worker.active).length === 0 ? (
          <span className="text-sm text-muted">Nobody is on this shipment.</span>
        ) : null}
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {shipment.lines.map((line) => (
          <li key={line.id}>
            {line.employeeName} counted {line.sku} {line.receivedQty}/{line.expectedQty}
            {line.variance === 0 ? "" : ` · off by ${line.variance}`}
          </li>
        ))}
      </ul>
      {manage && shipment.status !== "closed" ? (
        <form
          className="mt-4 grid gap-3 border-t border-black/5 pt-4 md:grid-cols-6"
          onSubmit={(event) => {
            event.preventDefault();
            void onAct(`/tracking/receiving/${shipment.id}/lines`, {
              badge,
              sku,
              expectedQty,
              receivedQty,
            });
          }}
        >
          <Field label="Badge">
            <input className="field font-mono" value={badge} onChange={(event) => setBadge(event.target.value)} />
          </Field>
          <Field label="SKU">
            <input className="field" value={sku} onChange={(event) => setSku(event.target.value)} />
          </Field>
          <Field label="Expected">
            <input className="field" type="number" min={0} value={expectedQty} onChange={(event) => setExpectedQty(Number(event.target.value))} />
          </Field>
          <Field label="Received">
            <input className="field" type="number" min={0} value={receivedQty} onChange={(event) => setReceivedQty(Number(event.target.value))} />
          </Field>
          <div className="flex items-end md:col-span-2">
            <button className="btn btn-primary w-full" type="submit">
              Add count
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
