"use client";

import Link from "next/link";
import { useState } from "react";
import { Field, Notice } from "@/components/ui";
import { ApiError, DEMO_BADGES, post } from "@/lib/api";

type Context = {
  employee: {
    name: string;
    badgeCode: string;
    departmentHome: string;
    warehanceUserId: string | null;
    clockedIn: boolean;
    onMeal: boolean;
  };
  task: {
    department: string;
    taskCode: string;
    activityName: string;
    startedAt: string;
    jobId: string | null;
    jobReference: string | null;
    clientName: string | null;
  } | null;
  paused: {
    taskCode: string;
    activityName: string;
    jobReference: string | null;
    clientName: string | null;
  } | null;
  jobs: { id: string; reference: string; title: string; clientName: string; clientCode: string }[];
  activities: { code: string; name: string; department: string; billable: boolean }[];
  station: string | null;
  checkout: string | null;
  stations: {
    code: string;
    label: string;
    loginMode: string;
    claimedBy: string | null;
    assignedTo: string | null;
  }[];
  scanners: {
    code: string;
    label: string;
    kind: string;
    ownership: string;
    assignedTo: string | null;
    checkedOutTo: string | null;
  }[];
  shipments: { id: string; reference: string; status: string; coworkers: string[] }[];
  loads: { id: string; reference: string; kind: string; dock: string; crew: string[] }[];
  gaylords: { id: string; code: string; carrier: string }[];
};

const AREAS = ["packing", "picking", "receiving", "unloading", "sorting"] as const;

export default function WarehousePage() {
  const [badge, setBadge] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [area, setArea] = useState<(typeof AREAS)[number]>("packing");
  const [jobId, setJobId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function load(nextBadge = badge) {
    setPending(true);
    setError(null);
    try {
      const result = await fetch(`/api/tracking/badge/${encodeURIComponent(nextBadge)}`).then(async (res) => {
        const body = (await res.json()) as Context & { message?: string };
        if (!res.ok) throw new ApiError(res.status, body.message ?? "That badge is not on the floor.");
        return body;
      });
      setContext(result);
      setBadge(result.employee.badgeCode);
      if (result.task?.jobId) setJobId(result.task.jobId);
      else if (!jobId && result.jobs[0]) setJobId(result.jobs[0].id);
      const department = result.task?.department;
      if (department && AREAS.includes(department as (typeof AREAS)[number])) {
        setArea(department as (typeof AREAS)[number]);
      }
    } catch (err) {
      setContext(null);
      setError(err instanceof ApiError ? err.message : "Could not read that badge.");
    } finally {
      setPending(false);
    }
  }

  async function run(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>(path, body);
      setMessage(result.message);
      await load(badge);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-lg px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Floor phone</p>
          <h1 className="text-2xl font-semibold">What are you on?</h1>
        </div>
        <Link className="text-sm text-moss" href="/gate">
          QR gate
        </Link>
      </div>
      {message ? <div className="mb-3"><Notice tone="ok">{message}</Notice></div> : null}
      {error ? <div className="mb-3"><Notice tone="bad">{error}</Notice></div> : null}
      {!context ? (
        <form
          className="card space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <Field label="Badge">
            <input
              className="field font-mono text-lg"
              autoFocus
              value={badge}
              onChange={(event) => setBadge(event.target.value)}
              placeholder="B-10442"
            />
          </Field>
          <button className="btn btn-primary tap w-full" disabled={pending} type="submit">
            {pending ? "Checking" : "Continue"}
          </button>
          <details className="text-sm text-muted">
            <summary className="cursor-pointer">Seeded badges</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              {DEMO_BADGES.map(([code, label]) => (
                <button
                  key={code}
                  className="rounded-full border border-black/10 px-3 py-2 text-left"
                  type="button"
                  onClick={() => {
                    setBadge(code);
                    void load(code);
                  }}
                >
                  <span className="block font-mono text-ink">{code}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </details>
        </form>
      ) : (
        <div className="space-y-4">
          <section className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{context.employee.name}</h2>
                <p className="text-sm text-muted">
                  {context.employee.clockedIn
                    ? context.employee.onMeal
                      ? "On a meal break"
                      : context.task
                        ? `On ${context.task.activityName}${context.task.clientName ? ` · ${context.task.clientName}` : ""}${context.task.jobReference ? ` ${context.task.jobReference}` : ""}`
                        : context.paused
                          ? `Paused ${context.paused.activityName}${context.paused.clientName ? ` · ${context.paused.clientName}` : ""}`
                          : "Clocked in, between tasks"
                    : "Not clocked in"}
                  {context.station ? ` · ${context.station}` : ""}
                  {context.checkout ? ` · holding ${context.checkout}` : ""}
                </p>
                <p className="mt-1 text-sm">
                  {context.employee.warehanceUserId
                    ? `Warehance login ${context.employee.warehanceUserId}`
                    : "No personal Warehance login"}
                </p>
              </div>
              <button className="btn btn-ghost" type="button" onClick={() => setContext(null)}>
                Change
              </button>
            </div>
            {!context.employee.clockedIn ? (
              <p className="mt-3 text-sm">
                Check in at the <Link className="text-moss" href="/gate">QR gate</Link> before work counts.
              </p>
            ) : null}
          </section>
          <section className="card space-y-3 p-4">
            <Field label="Client job">
              <select className="field" value={jobId} onChange={(event) => setJobId(event.target.value)}>
                {context.jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.clientName} · {job.reference} · {job.title}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              {(context.activities.length ? context.activities : AREAS.map((item) => ({ code: item, name: item, department: item, billable: true }))).map((activity) => (
                <button
                  key={activity.code}
                  className={`btn tap ${area === activity.department && context.task?.taskCode === activity.code ? "btn-primary" : "btn-ghost"}`}
                  type="button"
                  onClick={() => {
                    if (AREAS.includes(activity.department as (typeof AREAS)[number])) {
                      setArea(activity.department as (typeof AREAS)[number]);
                    }
                    if (context.employee.clockedIn && !context.employee.onMeal) {
                      void run("/tracking/tasks/switch", {
                        badge,
                        activityCode: activity.code,
                        jobId: activity.billable ? jobId : undefined,
                      });
                    }
                  }}
                >
                  {activity.name}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button className="btn btn-ghost tap flex-1" type="button" onClick={() => void run("/tracking/tasks/pause", { badge })}>
                Pause
              </button>
              <button className="btn btn-ghost tap flex-1" type="button" onClick={() => void run("/tracking/tasks/resume", { badge })}>
                Resume
              </button>
            </div>
          </section>
          {area === "packing" ? (
            <PackPanel context={context} badge={badge} run={run} />
          ) : null}
          {area === "picking" ? (
            <PickPanel context={context} badge={badge} run={run} />
          ) : null}
          {area === "receiving" ? (
            <ReceivePanel context={context} badge={badge} run={run} />
          ) : null}
          {area === "unloading" ? (
            <UnloadPanel context={context} badge={badge} run={run} />
          ) : null}
          {area === "sorting" ? (
            <SortPanel context={context} badge={badge} run={run} />
          ) : null}
        </div>
      )}
    </main>
  );
}

function PackPanel({
  context,
  badge,
  run,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<void>;
}) {
  const [deviceCode, setDeviceCode] = useState(context.station ?? context.stations[1]?.code ?? context.stations[0]?.code ?? "");
  const [orderNumber, setOrderNumber] = useState("");
  const station = context.stations.find((item) => item.code === deviceCode);
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run("/tracking/packing", {
          orderNumber,
          deviceCode,
          badge,
          units: 1,
          warehanceRecorded: station?.loginMode === "individual",
        });
      }}
    >
      <Field label="Packing computer">
        <select className="field" value={deviceCode} onChange={(event) => setDeviceCode(event.target.value)}>
          {context.stations.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} · {item.loginMode === "shared" ? "shared login" : item.assignedTo ?? "individual"}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-sm text-muted">
        {station?.loginMode === "shared"
          ? station.claimedBy
            ? `${station.claimedBy} currently holds this shared login.`
            : "Shared Warehance login. Claim it with your badge before the pack counts."
          : "This computer is an individual Warehance login."}
      </p>
      <button
        className="btn btn-ghost tap w-full"
        type="button"
        onClick={() => run("/tracking/stations/claim", { badge, deviceCode })}
      >
        Claim this computer
      </button>
      <Field label="Order you just packed">
        <input className="field" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} placeholder="WH-10021" />
      </Field>
      <button className="btn btn-primary tap w-full" type="submit">
        I finished this order
      </button>
    </form>
  );
}

function PickPanel({
  context,
  badge,
  run,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<void>;
}) {
  const [deviceCode, setDeviceCode] = useState(context.checkout ?? context.scanners[0]?.code ?? "");
  const [sku, setSku] = useState("");
  const [batchCode, setBatchCode] = useState("BATCH-20");
  const device = context.scanners.find((item) => item.code === deviceCode);
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run("/tracking/picking", { deviceCode, badge, batchCode, sku, qty: 1 });
      }}
    >
      <Field label="Scanner or handheld">
        <select className="field" value={deviceCode} onChange={(event) => setDeviceCode(event.target.value)}>
          {context.scanners.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} · {item.ownership === "personal" ? item.assignedTo : "shared"}
            </option>
          ))}
        </select>
      </Field>
      {device?.ownership === "shared_pool" ? (
        <button
          className="btn btn-ghost tap w-full"
          type="button"
          onClick={() => run("/tracking/devices/checkout", { badge, deviceCode })}
        >
          Check out {deviceCode}
        </button>
      ) : (
        <p className="text-sm text-muted">Personal scanner. The pick counts for {device?.assignedTo}.</p>
      )}
      <Field label="Batch">
        <input className="field" value={batchCode} onChange={(event) => setBatchCode(event.target.value)} />
      </Field>
      <Field label="SKU">
        <input className="field" value={sku} onChange={(event) => setSku(event.target.value)} placeholder="SKU-TEE" />
      </Field>
      <button className="btn btn-primary tap w-full" type="submit">
        Scan pick
      </button>
    </form>
  );
}

function ReceivePanel({
  context,
  badge,
  run,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<void>;
}) {
  const [shipmentId, setShipmentId] = useState(context.shipments[0]?.id ?? "");
  const [sku, setSku] = useState("");
  const [expectedQty, setExpectedQty] = useState(1);
  const [receivedQty, setReceivedQty] = useState(1);
  const shipment = context.shipments.find((item) => item.id === shipmentId);
  return (
    <div className="card space-y-3 p-4">
      {context.shipments.length === 0 ? <p>No open shipments.</p> : null}
      <Field label="Shipment">
        <select className="field" value={shipmentId} onChange={(event) => setShipmentId(event.target.value)}>
          {context.shipments.map((item) => (
            <option key={item.id} value={item.id}>
              {item.reference}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-sm text-muted">
        {shipment && shipment.coworkers.length > 0
          ? `Already on it: ${shipment.coworkers.join(", ")}. You can join them.`
          : "Nobody is on this shipment yet."}
      </p>
      <button
        className="btn btn-ghost tap w-full"
        type="button"
        onClick={() => run(`/tracking/receiving/${shipmentId}/join`, { badge, role: "counter" })}
      >
        Join this shipment
      </button>
      <Field label="SKU">
        <input className="field" value={sku} onChange={(event) => setSku(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expected">
          <input className="field" type="number" min={0} value={expectedQty} onChange={(event) => setExpectedQty(Number(event.target.value))} />
        </Field>
        <Field label="Received">
          <input className="field" type="number" min={0} value={receivedQty} onChange={(event) => setReceivedQty(Number(event.target.value))} />
        </Field>
      </div>
      <button
        className="btn btn-primary tap w-full"
        type="button"
        onClick={() =>
          run(`/tracking/receiving/${shipmentId}/lines`, { badge, sku, expectedQty, receivedQty })
        }
      >
        Save my count
      </button>
    </div>
  );
}

function UnloadPanel({
  context,
  badge,
  run,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<void>;
}) {
  const [loadId, setLoadId] = useState(context.loads[0]?.id ?? "");
  const load = context.loads.find((item) => item.id === loadId);
  return (
    <div className="card space-y-3 p-4">
      <Field label="Truck or container">
        <select className="field" value={loadId} onChange={(event) => setLoadId(event.target.value)}>
          {context.loads.map((item) => (
            <option key={item.id} value={item.id}>
              {item.reference} · {item.dock}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-sm text-muted">
        {load && load.crew.length > 0 ? `On it now: ${load.crew.join(", ")}.` : "No crew yet."}
      </p>
      <button
        className="btn btn-primary tap w-full"
        type="button"
        onClick={() => run(`/tracking/unloading/${loadId}/crew`, { source: "badge", badge })}
      >
        Badge onto this load
      </button>
    </div>
  );
}

function SortPanel({
  context,
  badge,
  run,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<void>;
}) {
  const [gaylordCode, setGaylordCode] = useState(context.gaylords[0]?.code ?? "");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [method, setMethod] = useState<"scan" | "manual_place">("scan");
  const [reason, setReason] = useState("");
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run("/tracking/sorting/scan", {
          gaylordCode,
          trackingNumber,
          badge,
          method,
          reason: method === "manual_place" ? reason : undefined,
        });
      }}
    >
      <Field label="Gaylord">
        <select className="field" value={gaylordCode} onChange={(event) => setGaylordCode(event.target.value)}>
          {context.gaylords.map((item) => (
            <option key={item.id} value={item.code}>
              {item.code} · {item.carrier.toUpperCase()}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tracking number">
        <input className="field font-mono" value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} />
      </Field>
      <Field label="How it went in">
        <select className="field" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
          <option value="scan">Scanned</option>
          <option value="manual_place">Placed without a scan</option>
        </select>
      </Field>
      {method === "manual_place" ? (
        <Field label="Reason">
          <input className="field" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      ) : null}
      <button className="btn btn-primary tap w-full" type="submit">
        Put it in the gaylord
      </button>
    </form>
  );
}
