"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Field, Notice } from "@/components/ui";
import { ApiError, billBasisLabel, post, when } from "@/lib/api";
import { badgeFromScan } from "@/lib/qr";

type Context = {
  employee: {
    name: string;
    badgeCode: string;
    departmentHome: string;
    departments?: string[] | null;
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
    department: string;
    taskCode: string;
    activityName: string;
    jobId: string | null;
    jobReference: string | null;
    clientName: string | null;
  } | null;
  tasks: {
    id: string;
    title: string;
    jobReference: string | null;
    activityName: string | null;
    startAt: string | null;
    dueOn: string | null;
  }[];
  jobs: {
    id: string;
    reference: string;
    title: string;
    clientName: string;
    clientCode: string;
    billBasis: string;
    clientId: string | null;
    startAt: string | null;
    startActivity: string | null;
    startedAuto: boolean;
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
  shipments: { id: string; jobId: string | null; reference: string; status: string; coworkers: string[] }[];
  loads: { id: string; jobId: string | null; reference: string; kind: string; dock: string; crew: string[] }[];
  gaylords: { id: string; code: string; carrier: string }[];
};

function readPosition() {
  return new Promise<{ latitude: number; longitude: number; accuracy: number; capturedAt: number } | null>((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          capturedAt: position.timestamp,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  });
}

function stamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

const AREAS = ["packing", "picking", "receiving", "unloading", "sorting"] as const;

const serviceForDepartment: Record<string, string> = {
  packing: "packing",
  picking: "picking",
  receiving: "receiving",
  unloading: "unloading",
  sorting: "sorting",
};

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const total = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return <>{`${pad(hours)}:${pad(minutes)}:${pad(seconds)}`}</>;
}

export default function WarehousePage() {
  const [badge, setBadge] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [jobId, setJobId] = useState("");
  const [taskCode, setTaskCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [finished, setFinished] = useState<string[]>([]);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const scanned = useRef(false);

  useEffect(() => {
    return () => {
      void scannerRef.current?.stop().catch(() => undefined);
    };
  }, []);

  async function stopCamera() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    setCameraOn(false);
    try {
      await scanner?.stop();
      scanner?.clear();
    } catch {
      /* already stopped */
    }
  }

  async function startCamera() {
    setCameraError(null);
    setError(null);
    scanned.current = false;
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("floor-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          if (scanned.current) return;
          const code = badgeFromScan(decoded);
          if (!code) return;
          scanned.current = true;
          void stopCamera().then(() => {
            setBadge(code);
            void load(code, true);
          });
        },
        () => undefined,
      );
      setCameraOn(true);
    } catch {
      scannerRef.current = null;
      setCameraOn(false);
      setCameraError("The camera did not start. Allow camera access, or type the badge below.");
    }
  }

  // When someone opens the phone with their badge, location mode needs the device at the warehouse.
  async function arrive(nextBadge: string) {
    // The server decides whether a location is needed. Check-in off, or QR gate mode, needs none.
    const first = await post<{ needsLocation: boolean }>("/tracking/phone/arrive", { badge: nextBadge });
    if (!first.needsLocation) return;
    const fix = await readPosition();
    if (!fix) throw new ApiError(400, "This device must share its location. A scan without it is not recorded.");
    await post("/tracking/phone/arrive", {
      badge: nextBadge,
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      capturedAt: fix.capturedAt,
    });
  }

  async function load(nextBadge = badge, opening = false) {
    setPending(true);
    setError(null);
    try {
      if (opening) await arrive(nextBadge);
      const result = await fetch(`/api/tracking/badge/${encodeURIComponent(nextBadge)}`).then(async (res) => {
        const body = (await res.json()) as Context & { message?: string };
        if (!res.ok) throw new ApiError(res.status, body.message ?? "That badge is not on the floor.");
        return body;
      });
      setContext(result);
      setBadge(result.employee.badgeCode);
    } catch (err) {
      setContext(null);
      setError(err instanceof ApiError ? err.message : "Could not read that badge.");
    } finally {
      setPending(false);
    }
  }

  async function run(path: string, body: unknown) {
    if (saving) return false;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>(path, body);
      setMessage(result.message);
      await load(badge);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    const ending = context?.task?.taskCode ?? context?.paused?.taskCode ?? null;
    setConfirmEnd(false);
    const done = await run("/tracking/tasks/stop", { badge });
    if (done) {
      if (ending) setFinished((list) => (list.includes(ending) ? list : [...list, ending]));
      setTaskCode("");
      setJobId("");
    }
  }

  const jobs = (context?.jobs ?? []).filter(
    (job) => !context?.employee.clientId || job.clientId === context.employee.clientId,
  );
  const startable = (context?.activities ?? []).filter((activity) => {
    if (!context) return false;
    const allowed = context.employee.departments;
    if (allowed?.length && activity.department !== "indirect" && !allowed.includes(activity.department)) return false;
    if (!activity.billable) return true;
    const service = serviceForDepartment[activity.department];
    if (!service) return false;
    return jobs.some((job) => job.enabledServices.includes(service));
  });
  const choices = startable.filter((activity) => !finished.includes(activity.code));
  const chosen = choices.find((item) => item.code === taskCode) ?? (choices.length === 1 ? choices[0] : null);
  const projects = chosen?.billable
    ? jobs.filter((job) => {
        const service = serviceForDepartment[chosen.department];
        return !service || job.enabledServices.includes(service);
      })
    : [];
  const picked = projects.find((job) => job.id === jobId) ?? (projects.length === 1 ? projects[0] : null);
  const ready = Boolean(chosen && (!chosen.billable || picked));
  const working = context?.task ?? null;
  const paused = !working ? context?.paused ?? null : null;
  const checkedIn = Boolean(context?.employee.clockedIn);
  const onMeal = Boolean(context?.employee.onMeal);
  const currentJobId = working?.jobId ?? paused?.jobId ?? picked?.id ?? null;
  const activeDepartment = working?.department ?? paused?.department ?? chosen?.department ?? null;
  const panel =
    activeDepartment && (AREAS as readonly string[]).includes(activeDepartment)
      ? (activeDepartment as (typeof AREAS)[number])
      : null;
  const hint = !checkedIn
    ? "Check in at the QR gate first."
    : !chosen
      ? "Choose the kind of work."
      : chosen.billable && !picked
        ? "Choose a project."
        : null;

  return (
    <main className={`mx-auto min-h-screen max-w-lg px-4 py-6 ${context ? "pb-40" : ""}`}>
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
            void load(badge, true);
          }}
        >
          <div id="floor-qr-reader" className="overflow-hidden rounded-xl bg-black/5" />
          {cameraError ? <Notice tone="bad">{cameraError}</Notice> : null}
          {cameraOn ? (
            <button className="btn btn-ghost tap w-full" type="button" onClick={() => void stopCamera()}>
              Stop camera
            </button>
          ) : (
            <button className="btn btn-primary tap w-full" type="button" onClick={() => void startCamera()}>
              Scan my QR code
            </button>
          )}
          <p className="text-center text-sm text-muted">or type the badge</p>
          <Field label="Badge">
            <input
              className="field font-mono text-lg"
              value={badge}
              onChange={(event) => setBadge(event.target.value)}
              placeholder="Badge"
            />
          </Field>
          <button className="btn btn-ghost tap w-full" disabled={pending || badge.trim() === ""} type="submit">
            {pending ? "Checking" : "Continue"}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <section className="card flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold">{context.employee.name}</h2>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    !checkedIn ? "bg-rust/10 text-rust" : onMeal ? "bg-clay/10 text-clay" : "bg-moss/10 text-moss"
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {!checkedIn ? "Not checked in" : onMeal ? "On a meal break" : "Checked in"}
                </span>
                {context.station ? <span className="text-muted">{context.station}</span> : null}
                {context.checkout ? <span className="text-muted">holding {context.checkout}</span> : null}
              </p>
            </div>
            <button
              className="btn btn-ghost shrink-0"
              type="button"
              onClick={() => {
                setContext(null);
                setFinished([]);
                setTaskCode("");
                setJobId("");
                setConfirmEnd(false);
              }}
            >
              Not you?
            </button>
          </section>

          {!checkedIn ? (
            <section className="card space-y-2 border-rust/30 p-4">
              <p className="font-medium">Check in before you start</p>
              <p className="text-sm text-muted">
                Time only counts after a scan at the QR gate. Once you are checked in, come back here.
              </p>
              <Link className="btn btn-primary tap w-full" href="/gate">
                Open the QR gate
              </Link>
            </section>
          ) : null}

          {checkedIn && onMeal ? (
            <section className="card space-y-3 p-4">
              <p className="font-medium">You are on a meal break</p>
              <p className="text-sm text-muted">Your timer is paused. End the break to carry on.</p>
              <button
                className="btn btn-primary tap w-full"
                type="button"
                disabled={saving}
                onClick={() => void run("/tracking/clock", { badge, action: "meal_end", source: "kiosk" })}
              >
                End meal break
              </button>
            </section>
          ) : null}

          {checkedIn && !onMeal && working ? (
            <section className="card overflow-hidden">
              <div className="bg-moss px-4 py-5 text-paper">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em]">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-paper" />
                  Timer running
                </p>
                <p className="mt-2 font-mono text-5xl font-semibold tabular-nums">
                  <Elapsed since={working.startedAt} />
                </p>
              </div>
              <div className="space-y-1 p-4">
                <p className="text-lg font-semibold">{working.activityName}</p>
                {working.jobReference ? (
                  <p className="text-sm">
                    {working.clientName ? `${working.clientName} · ` : ""}
                    {working.jobReference}
                  </p>
                ) : null}
                <p className="text-sm text-muted">Started {when(working.startedAt)}</p>
              </div>
            </section>
          ) : null}

          {checkedIn && !onMeal && paused ? (
            <section className="card overflow-hidden">
              <div className="bg-clay px-4 py-4 text-paper">
                <p className="text-xs font-semibold uppercase tracking-[0.16em]">Paused</p>
                <p className="mt-1 text-lg font-semibold">The timer is stopped</p>
              </div>
              <div className="space-y-1 p-4">
                <p className="text-lg font-semibold">{paused.activityName}</p>
                {paused.jobReference ? (
                  <p className="text-sm">
                    {paused.clientName ? `${paused.clientName} · ` : ""}
                    {paused.jobReference}
                  </p>
                ) : null}
                <p className="text-sm text-muted">The minutes already worked stay on the project. Resume to keep counting.</p>
              </div>
            </section>
          ) : null}

          {checkedIn && !onMeal && (context.tasks?.length ?? 0) > 0 ? (
            <section className="card p-4">
              <p className="mb-2 text-sm font-semibold">Your tasks</p>
              <ul className="space-y-2 text-sm">
                {context.tasks.map((item) => (
                  <li key={item.id}>
                    <span className="font-medium">{item.title}</span>
                    <span className="block text-xs text-muted">
                      {item.jobReference ?? "Project"}
                      {item.startAt ? ` · starts ${when(item.startAt)}` : ""}
                      {item.dueOn ? ` · due ${item.dueOn}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!working && !paused && !onMeal ? (
            <section className="space-y-5">
              <div>
                <p className="mb-2 text-sm font-semibold">
                  <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-ink text-xs text-paper">1</span>
                  What kind of work?
                </p>
                {startable.length === 0 ? (
                  <p className="card p-4 text-sm text-muted">
                    {jobs.length === 0
                      ? `${context.employee.name} is not assigned to an open project. Ask a manager to assign you on the job.`
                      : "No task type is turned on for your projects yet. Ask a manager to turn the service on for the client."}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {startable.map((activity) => {
                      const done = finished.includes(activity.code);
                      const active = chosen?.code === activity.code;
                      return (
                        <button
                          key={activity.id}
                          type="button"
                          disabled={saving || done}
                          aria-pressed={active}
                          className={`min-h-12 rounded-full border px-4 text-sm font-semibold transition ${
                            active
                              ? "border-moss bg-moss text-paper"
                              : done
                                ? "border-black/10 bg-black/[0.03] text-muted line-through"
                                : "border-black/15 bg-surface text-ink active:bg-black/5"
                          }`}
                          onClick={() => {
                            setTaskCode(activity.code);
                            setJobId("");
                            setError(null);
                          }}
                        >
                          {activity.name}
                          {done ? <span className="ml-1 text-xs font-normal no-underline">· done</span> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {chosen && chosen.billable ? (
                <div>
                  <p className="mb-2 text-sm font-semibold">
                    <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-ink text-xs text-paper">2</span>
                    Which project?
                  </p>
                  {projects.length === 0 ? (
                    <p className="card p-4 text-sm text-muted">No project of yours uses this kind of work.</p>
                  ) : (
                    <div className="space-y-2">
                      {projects.map((job) => {
                        const selected = picked?.id === job.id;
                        return (
                          <button
                            key={job.id}
                            type="button"
                            aria-pressed={selected}
                            disabled={saving}
                            className={`card w-full p-4 text-left transition ${
                              selected ? "border-moss ring-2 ring-moss/30" : "active:bg-black/5"
                            }`}
                            onClick={() => {
                              setJobId(job.id);
                              setError(null);
                            }}
                          >
                            <span className="flex items-start justify-between gap-3">
                              <span className="min-w-0">
                                <span className="block text-xs uppercase tracking-[0.12em] text-muted">
                                  {job.clientName} · {job.reference}
                                </span>
                                <span className="mt-0.5 block font-semibold">{job.title}</span>
                                <span className="mt-1 block text-xs text-muted">
                                  {billBasisLabel(job.billBasis)}
                                  {" · "}
                                  {job.startAt
                                    ? job.startedAuto
                                      ? `Started by the set time ${stamp(job.startAt)}`
                                      : `Starts by itself at ${stamp(job.startAt)}`
                                    : "You start it when you begin"}
                                </span>
                              </span>
                              <span
                                className={`mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${
                                  selected ? "border-moss bg-moss text-paper" : "border-black/20"
                                }`}
                              >
                                {selected ? "✓" : ""}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {panel ? (
            <section>
              <p className="mb-2 text-sm font-semibold text-muted">Record your work</p>
              {panel === "packing" ? <PackPanel context={context} badge={badge} run={run} /> : null}
              {panel === "picking" ? <PickPanel context={context} badge={badge} run={run} /> : null}
              {panel === "receiving" ? (
                <ReceivePanel context={context} badge={badge} run={run} jobId={currentJobId} />
              ) : null}
              {panel === "unloading" ? (
                <UnloadPanel context={context} badge={badge} run={run} jobId={currentJobId} />
              ) : null}
              {panel === "sorting" ? <SortPanel context={context} badge={badge} run={run} /> : null}
            </section>
          ) : null}
        </div>
      )}
      {context && checkedIn && !onMeal ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-black/10 bg-paper/95 px-4 pb-5 pt-3 backdrop-blur">
          <div className="mx-auto max-w-lg space-y-2">
            {working && !confirmEnd ? (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn btn-ghost tap min-h-14 text-base" type="button" disabled={saving} onClick={() => void run("/tracking/tasks/pause", { badge })}>
                  Pause
                </button>
                <button className="btn btn-primary tap min-h-14 text-base" type="button" disabled={saving} onClick={() => setConfirmEnd(true)}>
                  End
                </button>
              </div>
            ) : null}
            {paused && !confirmEnd ? (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn btn-primary tap min-h-14 text-base" type="button" disabled={saving} onClick={() => void run("/tracking/tasks/resume", { badge })}>
                  Resume
                </button>
                <button className="btn btn-ghost tap min-h-14 text-base" type="button" disabled={saving} onClick={() => setConfirmEnd(true)}>
                  End
                </button>
              </div>
            ) : null}
            {(working || paused) && confirmEnd ? (
              <>
                <p className="text-center text-sm font-medium">End now and save this time on the project?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button className="btn btn-ghost tap min-h-14 text-base" type="button" disabled={saving} onClick={() => setConfirmEnd(false)}>
                    Keep going
                  </button>
                  <button className="btn btn-primary tap min-h-14 text-base" type="button" disabled={saving} onClick={() => void finish()}>
                    Yes, end
                  </button>
                </div>
              </>
            ) : null}
            {!working && !paused ? (
              <>
                {hint ? <p className="text-center text-sm text-muted">{hint}</p> : null}
                <button
                  className="btn btn-primary tap min-h-14 w-full text-base disabled:bg-ink/15 disabled:text-muted disabled:opacity-100"
                  type="button"
                  disabled={saving || !ready}
                  onClick={() =>
                    void run("/tracking/tasks/switch", {
                      badge,
                      activityCode: chosen?.code,
                      ...(picked ? { jobId: picked.id } : {}),
                    })
                  }
                >
                  {ready && chosen ? `Start ${chosen.name}${picked ? ` on ${picked.reference}` : ""}` : "Start timer"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
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
  run: (path: string, body: unknown) => Promise<boolean>;
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
  run: (path: string, body: unknown) => Promise<boolean>;
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
  jobId,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<boolean>;
  jobId: string | null;
}) {
  const shipments = jobId ? context.shipments.filter((item) => item.jobId === jobId) : [];
  const [shipmentId, setShipmentId] = useState(shipments[0]?.id ?? "");
  const [sku, setSku] = useState("");
  const [expectedQty, setExpectedQty] = useState(1);
  const [receivedQty, setReceivedQty] = useState(1);
  useEffect(() => {
    const next = jobId ? context.shipments.filter((item) => item.jobId === jobId).map((item) => item.id) : [];
    setShipmentId((current) => (next.includes(current) ? current : next[0] ?? ""));
  }, [jobId, context.shipments]);
  const shipment = shipments.find((item) => item.id === shipmentId);
  if (!jobId) {
    return <p className="card p-4 text-sm text-muted">Choose the project first. Only that job’s shipment will show.</p>;
  }
  if (shipments.length === 0) {
    return <p className="card p-4 text-sm text-muted">No open shipment on this job.</p>;
  }
  return (
    <div className="card space-y-3 p-4">
      <Field label="Shipment">
        {shipments.length === 1 ? (
          <p className="field flex items-center">{shipment?.reference}</p>
        ) : (
          <select className="field" value={shipmentId} onChange={(event) => setShipmentId(event.target.value)}>
            {shipments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference}
              </option>
            ))}
          </select>
        )}
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
  jobId,
}: {
  context: Context;
  badge: string;
  run: (path: string, body: unknown) => Promise<boolean>;
  jobId: string | null;
}) {
  const loads = jobId ? context.loads.filter((item) => item.jobId === jobId) : [];
  const [loadId, setLoadId] = useState(loads[0]?.id ?? "");
  useEffect(() => {
    const next = jobId ? context.loads.filter((item) => item.jobId === jobId).map((item) => item.id) : [];
    setLoadId((current) => (next.includes(current) ? current : next[0] ?? ""));
  }, [jobId, context.loads]);
  const load = loads.find((item) => item.id === loadId);
  if (!jobId) {
    return <p className="card p-4 text-sm text-muted">Choose the project first. Only that job’s truck will show.</p>;
  }
  if (loads.length === 0) {
    return <p className="card p-4 text-sm text-muted">No open truck or container on this job.</p>;
  }
  return (
    <div className="card space-y-3 p-4">
      <Field label="Truck or container">
        {loads.length === 1 ? (
          <p className="field flex items-center">
            {load?.reference} · {load?.dock}
          </p>
        ) : (
          <select className="field" value={loadId} onChange={(event) => setLoadId(event.target.value)}>
            {loads.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference} · {item.dock}
              </option>
            ))}
          </select>
        )}
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
  run: (path: string, body: unknown) => Promise<boolean>;
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
