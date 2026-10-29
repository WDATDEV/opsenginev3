"use client";

import Link from "next/link";
import { useState } from "react";
import { Field, Notice } from "@/components/ui";
import { ApiError, billBasisLabel, post, when } from "@/lib/api";

type Context = {
  employee: {
    name: string;
    badgeCode: string;
    departmentHome: string;
    clientId: string | null;
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
  jobs: {
    id: string;
    reference: string;
    title: string;
    clientName: string;
    clientCode: string;
    billBasis: string;
    clientId: string | null;
    enabledServices: string[];
  }[];
  activities: { id: string; code: string; name: string; department: string; billable: boolean }[];
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

const serviceForDepartment: Record<string, string> = {
  packing: "packing",
  picking: "picking",
  receiving: "receiving",
  unloading: "unloading",
  sorting: "sorting",
};

export default function WarehousePage() {
  const [badge, setBadge] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [jobId, setJobId] = useState("");
  const [taskCode, setTaskCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);

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
      if (result.task?.taskCode) setTaskCode(result.task.taskCode);
      else if (result.paused?.taskCode) setTaskCode(result.paused.taskCode);
    } catch (err) {
      setContext(null);
      setError(err instanceof ApiError ? err.message : "Could not read that badge.");
    } finally {
      setPending(false);
    }
  }

  async function run(path: string, body: unknown) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>(path, body);
      setMessage(result.message);
      await load(badge);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  const jobs = (context?.jobs ?? []).filter(
    (job) => !context?.employee.clientId || job.clientId === context.employee.clientId,
  );
  const taskTypes = (context?.activities ?? []).filter((activity) => {
    if (!context) return false;
    if (activity.code === context.task?.taskCode || activity.code === context.paused?.taskCode) return true;
    if (!activity.billable) return true;
    const service = serviceForDepartment[activity.department];
    if (!service) return false;
    return jobs.some((job) => job.enabledServices.includes(service));
  });
  const chosen = taskTypes.find((item) => item.code === taskCode) ?? null;
  const projects = chosen?.billable
    ? jobs.filter((job) => {
        const service = serviceForDepartment[chosen.department];
        return !service || job.enabledServices.includes(service);
      })
    : [];
  const panel =
    chosen && (AREAS as readonly string[]).includes(chosen.department)
      ? (chosen.department as (typeof AREAS)[number])
      : null;
  const billableTypes = taskTypes.filter((activity) => activity.billable);

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
              placeholder="Badge"
            />
          </Field>
          <button className="btn btn-primary tap w-full" disabled={pending || badge.trim() === ""} type="submit">
            {pending ? "Checking" : "Continue"}
          </button>
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
              </div>
              <button className="btn btn-ghost" type="button" onClick={() => setContext(null)}>
                Change
              </button>
            </div>
            {!context.employee.clockedIn ? (
              <div className="mt-3">
                <Notice tone="bad">
                  {context.employee.name} is not checked in. A project tap will not start the timer until a scan at the{" "}
                  <Link className="underline" href="/gate">QR gate</Link>.
                </Notice>
              </div>
            ) : null}
            {context.employee.onMeal ? (
              <button
                className="btn btn-primary tap mt-3 w-full"
                type="button"
                disabled={saving}
                onClick={() => void run("/tracking/clock", { badge, action: "meal_end", source: "kiosk" })}
              >
                End meal
              </button>
            ) : null}
          </section>
          <section className="card space-y-3 p-4">
            {context.task ? (
              <div className="rounded-lg bg-black/[0.04] p-3 text-sm">
                <p className="font-medium">Timer is running</p>
                <p>
                  {context.task.activityName}
                  {context.task.jobReference ? ` · ${context.task.clientName ?? ""} ${context.task.jobReference}` : ""}
                </p>
                <p className="text-muted">Started {when(context.task.startedAt)}</p>
              </div>
            ) : null}
            {context.paused ? (
              <p className="text-sm text-muted">
                Paused {context.paused.activityName}
                {context.paused.jobReference ? ` on ${context.paused.jobReference}` : ""}. The minutes already kept stay on the project.
              </p>
            ) : null}
            <p className="text-sm font-medium">1. Task type</p>
            {context.activities.length === 0 ? (
              <p className="text-sm text-muted">No task types are set up yet.</p>
            ) : null}
            {context.activities.length > 0 && billableTypes.length === 0 ? (
              <p className="text-sm text-muted">
                {jobs.length === 0
                  ? "No open project yet. Open a project before the timer can start."
                  : "No open project has a task type turned on. Turn that service on for the client, then choose it here."}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              {taskTypes.map((activity) => (
                <button
                  key={activity.id}
                  className={`btn tap ${taskCode === activity.code ? "btn-primary" : "btn-ghost"}`}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setTaskCode(activity.code);
                    setError(null);
                    if (!activity.billable) {
                      void run("/tracking/tasks/switch", { badge, activityCode: activity.code });
                    }
                  }}
                >
                  {activity.name}
                </button>
              ))}
            </div>
            {chosen && chosen.billable ? (
              <>
                <p className="text-sm font-medium">2. Project</p>
                <div className="space-y-2">
                  {projects.length === 0 ? <p className="text-sm text-muted">No open project for this task type.</p> : null}
                  {projects.map((job) => (
                    <button
                      key={job.id}
                      className={`btn tap w-full ${context.task?.jobId === job.id && context.task.taskCode === chosen.code ? "btn-primary" : "btn-ghost"}`}
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setJobId(job.id);
                        void run("/tracking/tasks/switch", { badge, activityCode: chosen.code, jobId: job.id });
                      }}
                    >
                      {job.clientName} · {job.reference}
                      <span className="block text-xs font-normal">{job.title} · {billBasisLabel(job.billBasis)}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className="flex gap-2">
              <button className="btn btn-ghost tap flex-1" type="button" disabled={saving} onClick={() => void run("/tracking/tasks/pause", { badge })}>
                Pause
              </button>
              <button className="btn btn-ghost tap flex-1" type="button" disabled={saving} onClick={() => void run("/tracking/tasks/stop", { badge })}>
                End
              </button>
              <button className="btn btn-ghost tap flex-1" type="button" disabled={saving} onClick={() => void run("/tracking/tasks/resume", { badge })}>
                Resume
              </button>
            </div>
          </section>
          {panel === "packing" ? (
            <PackPanel context={context} badge={badge} run={run} />
          ) : null}
          {panel === "picking" ? (
            <PickPanel context={context} badge={badge} run={run} />
          ) : null}
          {panel === "receiving" ? (
            <ReceivePanel context={context} badge={badge} run={run} />
          ) : null}
          {panel === "unloading" ? (
            <UnloadPanel context={context} badge={badge} run={run} />
          ) : null}
          {panel === "sorting" ? (
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
  const [deviceCode, setDeviceCode] = useState(context.station ?? context.stations[0]?.code ?? "");
  const [orderNumber, setOrderNumber] = useState("");
  const station = context.stations.find((item) => item.code === deviceCode);
  if (context.stations.length === 0) {
    return <p className="card p-4 text-sm text-muted">No packing computer is on the floor yet.</p>;
  }
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
            : "Shared station login. Claim it with your badge before the pack counts."
          : "This computer is an individual station."}
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
  const [batchCode, setBatchCode] = useState("");
  const device = context.scanners.find((item) => item.code === deviceCode);
  if (context.scanners.length === 0) {
    return <p className="card p-4 text-sm text-muted">No scanner or handheld is on the floor yet.</p>;
  }
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
  if (context.shipments.length === 0) {
    return <p className="card p-4 text-sm text-muted">No open shipment for this project.</p>;
  }
  return (
    <div className="card space-y-3 p-4">
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
  if (context.loads.length === 0) {
    return <p className="card p-4 text-sm text-muted">No open truck or container.</p>;
  }
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
  if (context.gaylords.length === 0) {
    return <p className="card p-4 text-sm text-muted">No open gaylord.</p>;
  }
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
