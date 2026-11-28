"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Field, Flash, MoreButton, Notice, PageTitle, Progress, SearchBox, Segmented, SkeletonList, Stat, StatGrid, usePaged, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";
import { problemHref } from "@/lib/problems";

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
type View = "active" | "closed" | "all";

const VIEWS = [
  ["active", "Active"],
  ["closed", "Closed"],
  ["all", "All"],
] as const;

export function ReceivingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Shipment[]>("/tracking/receiving");
  const jobs = useResource<{ jobs: JobOption[] }>("/jobs");
  const user = useSession();
  const manage = canManage(user?.role);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [carrier, setCarrier] = useState("");
  const [expected, setExpected] = useState("");
  const [jobId, setJobId] = useState("");
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");

  async function act(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, body);
      setMessage(result.message ?? "Saved.");
      board.reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update receiving.");
      return false;
    }
  }

  const openJobs = (jobs.data?.jobs ?? []).filter((job) => job.status !== "done" && (!client || job.clientId === client.id));
  const selectedJob = openJobs.some((job) => job.id === jobId) ? jobId : (openJobs[0]?.id ?? "");
  const shipments = (board.data ?? []).filter((shipment) => !client || shipment.clientId === client.id);
  const active = shipments.filter((shipment) => shipment.status !== "closed");
  const query = search.trim().toLowerCase();
  const list = shipments.filter(
    (shipment) =>
      (view === "all" || (view === "closed") === (shipment.status === "closed")) &&
      (!query || `${shipment.reference} ${shipment.carrier} ${shipment.jobReference ?? ""} ${shipment.clientName ?? ""}`.toLowerCase().includes(query)),
  );
  const paged = usePaged(list, 10);
  const shortLines = active.reduce((sum, shipment) => sum + shipment.lines.filter((line) => line.variance !== 0).length, 0);

  return (
    <div>
      <PageTitle
        kicker="Receiving"
        title={client ? `Receiving for ${client.name}` : "Inbound shipments"}
        detail="Open a shipment on a job. Anyone clocked in can join, and each count stays with the person who entered it."
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <StatGrid>
        <Stat label="Active shipments" value={active.length} tone="ok" />
        <Stat label="People receiving" value={new Set(active.flatMap((shipment) => shipment.workers.filter((worker) => worker.active).map((worker) => worker.name))).size} />
        <Stat label="Still to receive" value={active.reduce((sum, shipment) => sum + Math.max(0, shipment.expectedCartons - shipment.receivedCartons), 0).toLocaleString()} />
        <Stat label="Count differences" value={shortLines} tone={shortLines ? "warn" : undefined} note="on active shipments" />
      </StatGrid>

      {manage ? (
        <form
          className="card mb-5 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedJob) {
              setMessage(null);
              setError("Open a job for this client before opening a shipment.");
              return;
            }
            void act("/tracking/receiving", {
              reference,
              jobId: selectedJob,
              carrier,
              expectedCartons: Number(expected || 0),
            }).then((saved) => {
              if (!saved) return;
              setReference("");
              setExpected("");
            });
          }}
        >
          <h2 className="mb-3 font-semibold">Open a shipment</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_8rem_auto]">
            <Field label="Shipment">
              <input className="field font-mono" required value={reference} onChange={(event) => setReference(event.target.value)} placeholder="ASN-4402" />
            </Field>
            <Field label="Job">
              <select className="field" value={selectedJob} disabled={openJobs.length === 0} onChange={(event) => setJobId(event.target.value)}>
                {openJobs.length === 0 ? <option value="">No open jobs</option> : null}
                {openJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {client ? job.reference : `${job.clientName} · ${job.reference}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Carrier">
              <input className="field" required value={carrier} onChange={(event) => setCarrier(event.target.value)} placeholder="XPO" />
            </Field>
            <Field label="Expected units">
              <input className="field" type="number" min={0} required value={expected} onChange={(event) => setExpected(event.target.value)} />
            </Field>
            <div className="flex items-end">
              <button className="btn btn-primary w-full" type="submit" disabled={openJobs.length === 0}>
                Open shipment
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Show shipments" options={VIEWS} value={view} onChange={setView} />
        <SearchBox value={search} onChange={setSearch} label="Search shipments" placeholder="Search shipment or carrier" />
      </div>
      {board.loading && !board.data ? <SkeletonList rows={3} /> : null}
      {board.data && list.length === 0 ? (
        <div className="card">
          <EmptyRow title={query ? "Nothing matches that search" : view === "closed" ? "No closed shipments" : "No active shipments"}>{query ? null : "Shipments appear here once they are opened."}</EmptyRow>
        </div>
      ) : null}
      <div className="space-y-4">
        {paged.shown.map((shipment) => (
          <ShipmentCard key={shipment.id} shipment={shipment} manage={manage} onAct={act} />
        ))}
      </div>
      {paged.hidden > 0 ? <div className="card mt-4 overflow-hidden"><MoreButton hidden={paged.hidden} onClick={paged.more} /></div> : null}
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
  onAct: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [badge, setBadge] = useState("");
  const [sku, setSku] = useState("");
  const [expectedQty, setExpectedQty] = useState("");
  const [receivedQty, setReceivedQty] = useState("");
  const closed = shipment.status === "closed";
  const activeWorkers = shipment.workers.filter((worker) => worker.active);
  const progress = `${shipment.receivedCartons} of ${shipment.expectedCartons} received`;

  return (
    <article className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-lg font-semibold">{shipment.reference}</h3>
            <Badge tone={closed ? "neutral" : "ok"} dot>
              <span className="capitalize">{shipment.status}</span>
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted">{[shipment.clientName, shipment.jobReference, shipment.carrier].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {manage ? (
            <a
              className="btn btn-ghost btn-sm"
              href={problemHref({ kind: "receiving_discrepancy", shipmentId: shipment.id, clientId: shipment.clientId, title: `Shipment ${shipment.reference}: ` })}
            >
              Open a problem
            </a>
          ) : null}
          {manage && !closed ? (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                if (window.confirm(`Close shipment ${shipment.reference}? No more counts can be added.`)) void onAct(`/tracking/receiving/${shipment.id}/close`, {});
              }}
            >
              Close shipment
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex justify-between text-sm">
          <span className="text-muted">Received</span>
          <span className="font-mono tabular-nums">
            {shipment.receivedCartons} / {shipment.expectedCartons}
          </span>
        </div>
        <Progress value={shipment.receivedCartons} max={shipment.expectedCartons} label={progress} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {activeWorkers.map((worker) => (
          <span key={worker.name} className="badge badge-ok">
            {worker.name} · since {when(worker.joinedAt)}
          </span>
        ))}
        {activeWorkers.length === 0 && !closed ? <span className="text-sm text-muted">Nobody is on this shipment.</span> : null}
      </div>

      {shipment.lines.length ? (
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/5">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <thead className="bg-black/[0.03] text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Counted by</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-3 py-2 text-right font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {shipment.lines.map((line) => (
                <tr key={line.id} className="border-t border-black/5">
                  <td className="px-3 py-2 font-mono">{line.sku}</td>
                  <td className="px-3 py-2">{line.employeeName}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {line.receivedQty} / {line.expectedQty}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {line.receivedQty === line.expectedQty ? (
                      <Badge tone="ok">Match</Badge>
                    ) : (
                      <Badge tone="warn" dot>
                        {Math.abs(line.receivedQty - line.expectedQty)} {line.receivedQty < line.expectedQty ? "short" : "over"}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {manage && !closed ? (
        <form
          className="mt-4 grid gap-3 border-t border-black/5 pt-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_6.5rem_6.5rem_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void onAct(`/tracking/receiving/${shipment.id}/lines`, {
              badge,
              sku,
              expectedQty: Number(expectedQty),
              receivedQty: Number(receivedQty),
            }).then((saved) => {
              if (!saved) return;
              setSku("");
              setExpectedQty("");
              setReceivedQty("");
            });
          }}
        >
          <Field label="Badge">
            <input className="field font-mono" required autoComplete="off" value={badge} onChange={(event) => setBadge(event.target.value)} placeholder="Scan badge" />
          </Field>
          <Field label="SKU">
            <input className="field font-mono" required autoComplete="off" value={sku} onChange={(event) => setSku(event.target.value)} placeholder="Scan SKU" />
          </Field>
          <Field label="Expected">
            <input className="field" type="number" min={0} required value={expectedQty} onChange={(event) => setExpectedQty(event.target.value)} />
          </Field>
          <Field label="Received">
            <input className="field" type="number" min={0} required value={receivedQty} onChange={(event) => setReceivedQty(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Add count
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
