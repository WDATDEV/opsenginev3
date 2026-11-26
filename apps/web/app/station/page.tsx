"use client";

// The check-in station: a stand-alone screen for shared warehouse iPads.
// Staff scan a badge, check in or out with a tap, and run their tasks. It links to nothing else in Ops Engine.

import { useEffect, useRef, useState } from "react";
import { FloorGate } from "@/components/floor-access";
import { Field, Notice } from "@/components/ui";
import { api, ApiError, post, when } from "@/lib/api";
import { badgeFromScan } from "@/lib/qr";

// A shared iPad goes back to the scan screen when nobody touches it for this long.
const IDLE_RESET_MS = 45_000;

// Quick picks for why someone pauses. Keep in step with pauseReasons in packages/contracts.
const PAUSE_REASONS = [
  "Waiting for work",
  "Waiting on a supervisor",
  "Equipment or scanner problem",
  "Restroom",
  "Short break",
  "Helping a coworker",
  "Cleaning up",
];

function PauseReasonPicker({ saving, onPause, onCancel }: { saving: boolean; onPause: (reason: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const reason = (picked ?? other).trim();
  return (
    <div className="space-y-3">
      <p className="text-center text-sm font-semibold">Why are you pausing?</p>
      <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Pause reason">
        {PAUSE_REASONS.map((item) => {
          const on = picked === item;
          return (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                setPicked(on ? null : item);
                setOther("");
              }}
              className={`min-h-11 rounded-full border px-3.5 text-sm font-medium transition-colors ${
                on ? "border-moss bg-moss text-paper" : "border-black/15 bg-white text-ink hover:border-moss"
              }`}
            >
              {item}
            </button>
          );
        })}
      </div>
      <input
        className="field"
        value={other}
        maxLength={120}
        autoComplete="off"
        aria-label="Something else"
        placeholder="Something else? Type it here"
        onChange={(event) => {
          setOther(event.target.value);
          if (event.target.value) setPicked(null);
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <button className="btn btn-ghost tap min-h-14 text-base" type="button" disabled={saving} onClick={onCancel}>
          Keep working
        </button>
        <button className="btn btn-primary tap min-h-14 text-base" type="button" disabled={saving || !reason} onClick={() => onPause(reason)}>
          Pause
        </button>
      </div>
    </div>
  );
}

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
  shift: {
    clockIn: string;
    mealStartedAt: string | null;
    totalSeconds: number;
    taskSeconds: number;
    mealSeconds: number;
    pausedSeconds: number;
    pauses: { reason: string; seconds: number }[];
    unaccountedSeconds: number;
  } | null;
  task: {
    department: string;
    taskCode: string;
    activityName: string;
    startedAt: string;
    taskId: string | null;
    spentSeconds: number;
    jobId: string | null;
    jobReference: string | null;
    clientName: string | null;
  } | null;
  paused: {
    department: string;
    taskCode: string;
    activityName: string;
    taskId: string | null;
    spentSeconds: number;
    jobId: string | null;
    jobReference: string | null;
    clientName: string | null;
    pauseReason: string | null;
    pausedAt: string | null;
  } | null;
  tasks: {
    id: string;
    title: string;
    jobId: string | null;
    jobReference: string | null;
    clientName: string | null;
    activityCode: string | null;
    activityName: string | null;
    startAt: string | null;
    dueOn: string | null;
    blocked: boolean;
    fromJob: boolean;
    spentSeconds: number;
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
    completedCodes: string[];
    workCodes: string[] | null;
  }[];
  activities: { id: string; code: string; name: string; department: string; billable: boolean; clientId: string | null }[];
  station: string | null;
  checkout: string | null;
  stations: {
    code: string;
    label: string;
    stationMode: string;
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

// Only work that records something on the floor gets a form while the timer runs.
const RECORD_PANEL: Record<string, "packing" | "picking" | "receiving" | "unloading" | "sorting"> = {
  pack_orders: "packing",
  pick_batch: "picking",
  receive_shipment: "receiving",
  unload_trailer: "unloading",
  sort_gaylord: "sorting",
};

function spentLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

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

function hoursLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export default function StationPage() {
  return (
    <FloorGate>
      <SignedInWarning />
      <Station />
    </FloorGate>
  );
}

// A manager signs in once to approve the iPad. Left signed in, staff could open the rest of Ops Engine.
function SignedInWarning() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    void api<{ signedIn?: boolean; approved: boolean }>("/tracking/floor-devices/me")
      .then((me) => setSignedIn(Boolean(me.signedIn && me.approved)))
      .catch(() => undefined);
  }, []);
  if (!signedIn) return null;
  return (
    <div className="mx-auto max-w-lg px-4 pt-4">
      <Notice tone="warn">
        Someone is signed in on this iPad. Sign out so staff only see the station.{" "}
        <button
          className="font-semibold underline"
          type="button"
          onClick={() => {
            void post("/auth/logout", {}).finally(() => window.location.reload());
          }}
        >
          Sign out
        </button>
      </Notice>
    </div>
  );
}

function Station() {
  const [badge, setBadge] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [choosingPause, setChoosingPause] = useState(false);
  const badgeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(timer);
  }, [message]);

  function reset() {
    setContext(null);
    setBadge("");
    setConfirmEnd(false);
    setConfirmOut(false);
    setChoosingPause(false);
    setError(null);
  }

  // Shared iPad: go back to the scan screen after a quiet spell, so the next person never sees someone else.
  useEffect(() => {
    if (!context) {
      badgeInput.current?.focus();
      return;
    }
    let timer = setTimeout(reset, IDLE_RESET_MS);
    const touched = () => {
      clearTimeout(timer);
      timer = setTimeout(reset, IDLE_RESET_MS);
    };
    window.addEventListener("pointerdown", touched);
    window.addEventListener("keydown", touched);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", touched);
      window.removeEventListener("keydown", touched);
    };
  }, [context]);
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
            void load(code);
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

  async function load(nextBadge = badge) {
    const code = badgeFromScan(nextBadge) ?? nextBadge.trim();
    if (!code) return;
    setPending(true);
    setError(null);
    try {
      const result = await fetch(`/api/tracking/badge/${encodeURIComponent(code)}`).then(async (res) => {
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
    setConfirmEnd(false);
    await run("/tracking/tasks/stop", { badge });
  }

  async function checkOut() {
    setConfirmOut(false);
    const done = await run("/tracking/clock", { badge, action: "out" });
    // Checked out: hand the iPad back to the next person, and keep the summary message on screen.
    if (done) {
      setContext(null);
      setBadge("");
    }
  }

  function startTask(item: Context["tasks"][number]) {
    void run(
      "/tracking/tasks/switch",
      item.fromJob ? { badge, activityCode: item.activityCode, jobId: item.jobId } : { badge, taskId: item.id },
    );
  }

  const internalWork = (context?.activities ?? []).filter(
    (activity) =>
      Boolean(context?.employee.departments?.includes("indirect")) && (activity.department === "indirect" || !activity.billable),
  );
  const working = context?.task ?? null;
  const paused = !working ? context?.paused ?? null : null;
  const currentTaskId = working?.taskId ?? paused?.taskId ?? null;
  // The task on the timer card is not repeated in the list below it.
  const myTasks = (context?.tasks ?? []).filter((item) => item.id !== currentTaskId);
  const busy = Boolean(working || paused);
  const checkedIn = Boolean(context?.employee.clockedIn);
  const onMeal = Boolean(context?.employee.onMeal);
  const currentJobId = working?.jobId ?? paused?.jobId ?? null;
  const currentCode = working?.taskCode ?? paused?.taskCode ?? "";
  const wanted = RECORD_PANEL[currentCode] ?? null;
  // A form with nothing to record against is noise, so it stays off the screen.
  const panel =
    wanted === "receiving" && !context?.shipments.some((item) => item.jobId === currentJobId)
      ? null
      : wanted === "unloading" && !context?.loads.some((item) => item.jobId === currentJobId)
        ? null
        : wanted === "sorting" && !context?.gaylords.length
          ? null
          : wanted;

  return (
    <main className={`mx-auto min-h-screen max-w-lg px-4 py-6 ${choosingPause && working ? "pb-[26rem]" : working || paused ? "pb-40" : ""}`}>
      <div className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Check-in station</p>
        <h1 className="text-2xl font-semibold">
          {!context ? "Scan your badge" : !checkedIn ? "Welcome" : working ? "You're working" : paused ? "You're paused" : "You're on shift"}
        </h1>
      </div>
      {message ? <div className="mb-3"><Notice tone="ok">{message}</Notice></div> : null}
      {error ? <div className="mb-3"><Notice tone="bad">{error}</Notice></div> : null}
      {!context ? (
        <form
          className="card space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void load(badge);
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
          <p className="text-center text-sm text-muted">or use the scanner, or type the badge</p>
          <Field label="Badge">
            <input
              ref={badgeInput}
              className="field font-mono text-lg"
              value={badge}
              autoComplete="off"
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
            <button className="btn btn-ghost shrink-0" type="button" onClick={reset}>
              {checkedIn ? "Done" : "Not you?"}
            </button>
          </section>

          {!checkedIn ? (
            <section className="card space-y-3 p-4">
              <p className="font-medium">You are off shift</p>
              <p className="text-sm text-muted">Check in to start your time. Everything you do counts from here until you check out.</p>
              <button
                className="btn btn-primary tap min-h-16 w-full text-lg"
                type="button"
                disabled={saving}
                onClick={() => void run("/tracking/clock", { badge, action: "in" })}
              >
                Check in
              </button>
            </section>
          ) : null}

          {checkedIn && context.shift ? (
            <section className="card space-y-3 p-4">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">On shift since {when(context.shift.clockIn)}</p>
                  <p className="mt-1 font-mono text-4xl font-semibold tabular-nums">
                    <Elapsed since={context.shift.clockIn} />
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
                <div className="rounded-lg bg-moss/10 px-2 py-2">
                  <dt className="text-xs text-muted">On tasks</dt>
                  <dd className="font-semibold">{hoursLabel(context.shift.taskSeconds)}</dd>
                </div>
                <div className="rounded-lg bg-clay/10 px-2 py-2">
                  <dt className="text-xs text-muted">Paused</dt>
                  <dd className="font-semibold">{hoursLabel(context.shift.pausedSeconds)}</dd>
                </div>
                <div className="rounded-lg bg-clay/10 px-2 py-2">
                  <dt className="text-xs text-muted">Meal</dt>
                  <dd className="font-semibold">{hoursLabel(context.shift.mealSeconds)}</dd>
                </div>
                <div className="rounded-lg bg-black/[0.05] px-2 py-2">
                  <dt className="text-xs text-muted">Unaccounted</dt>
                  <dd className="font-semibold">{hoursLabel(context.shift.unaccountedSeconds)}</dd>
                </div>
              </dl>
              {context.shift.pauses.length > 0 ? (
                <p className="text-xs text-muted">
                  Paused for: {context.shift.pauses.map((item) => `${item.reason} ${hoursLabel(item.seconds)}`).join(" · ")}
                </p>
              ) : null}
              {confirmOut ? (
                <div className="space-y-2">
                  <p className="text-center text-sm font-medium">
                    {working || paused ? "Check out now? Your current task ends and is saved." : "Check out now and end your shift?"}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <button className="btn btn-ghost tap min-h-14 text-base" type="button" disabled={saving} onClick={() => setConfirmOut(false)}>
                      Stay on shift
                    </button>
                    <button className="btn btn-warn tap min-h-14 text-base" type="button" disabled={saving} onClick={() => void checkOut()}>
                      Yes, check out
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`grid gap-3 ${onMeal ? "grid-cols-1" : "grid-cols-2"}`}>
                  {!onMeal ? (
                    <button
                      className="btn btn-ghost tap min-h-14 text-base"
                      type="button"
                      disabled={saving}
                      onClick={() => void run("/tracking/clock", { badge, action: "meal_start" })}
                    >
                      Start meal break
                    </button>
                  ) : null}
                  <button className="btn btn-warn tap min-h-14 text-base" type="button" disabled={saving} onClick={() => setConfirmOut(true)}>
                    Check out
                  </button>
                </div>
              )}
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
                <p className="text-sm text-muted">Total time on this task</p>
              </div>
            </section>
          ) : null}

          {checkedIn && !onMeal && paused ? (
            <section className="card overflow-hidden">
              <div className="bg-clay px-4 py-4 text-paper">
                <p className="text-xs font-semibold uppercase tracking-[0.16em]">
                  Paused{paused.pausedAt ? ` for ` : ""}
                  {paused.pausedAt ? <Elapsed since={paused.pausedAt} /> : null}
                </p>
                <p className="mt-1 text-lg font-semibold">{paused.pauseReason ?? "The task timer is stopped"}</p>
              </div>
              <div className="space-y-1 p-4">
                <p className="text-lg font-semibold">{paused.activityName}</p>
                {paused.jobReference ? (
                  <p className="text-sm">
                    {paused.clientName ? `${paused.clientName} · ` : ""}
                    {paused.jobReference}
                  </p>
                ) : null}
                <p className="text-sm text-muted">
                  {spentLabel(paused.spentSeconds) ? `${spentLabel(paused.spentSeconds)} on this task so far. ` : ""}
                  Resume to keep counting, or switch to another task below.
                </p>
              </div>
            </section>
          ) : null}

          {panel ? (
            <section>
              <p className="mb-2 text-sm font-semibold text-muted">Record your work</p>
              {panel === "packing" ? <PackPanel badge={badge} run={run} /> : null}
              {panel === "picking" ? <PickPanel badge={badge} run={run} /> : null}
              {panel === "receiving" ? (
                <ReceivePanel context={context} badge={badge} run={run} jobId={currentJobId} />
              ) : null}
              {panel === "unloading" ? (
                <UnloadPanel context={context} badge={badge} run={run} jobId={currentJobId} />
              ) : null}
              {panel === "sorting" ? <SortPanel context={context} badge={badge} run={run} /> : null}
            </section>
          ) : null}

          {checkedIn && !onMeal && !(busy && myTasks.length === 0 && internalWork.length === 0) ? (
            <section aria-label="Your tasks">
              {busy ? (
                <p className="mb-2 text-sm font-semibold">
                  Your other tasks <span className="font-normal text-muted">· switching pauses the current one</span>
                </p>
              ) : null}
              {myTasks.length === 0 && internalWork.length === 0 ? (
                <div className="card p-6 text-center">
                  <p className="font-semibold">No tasks right now</p>
                  <p className="mt-1 text-sm text-muted">Ask a manager to give you a task.</p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {myTasks.map((item) => (
                    <li key={item.id} className={`card p-4 ${item.blocked ? "opacity-70" : ""}`}>
                      <p className="break-words text-lg font-semibold leading-snug">{item.title}</p>
                      <p className="mt-1 text-sm text-muted">
                        {[item.activityName, item.clientName, item.jobReference].filter(Boolean).join(" · ")}
                      </p>
                      {item.startAt || item.dueOn || spentLabel(item.spentSeconds) ? (
                        <p className="mt-1 text-xs text-muted">
                          {[
                            spentLabel(item.spentSeconds) ? `${spentLabel(item.spentSeconds)} so far` : "",
                            item.startAt ? `Starts ${when(item.startAt)}` : "",
                            item.dueOn ? `Due ${item.dueOn}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      ) : null}
                      {item.blocked ? (
                        <p className="mt-3 rounded-lg bg-black/[0.04] px-3 py-2.5 text-center text-sm font-medium text-muted">Waiting on an earlier task</p>
                      ) : (
                        <button
                          className={`btn tap mt-3 min-h-14 w-full text-base ${busy ? "btn-ghost" : "btn-primary"}`}
                          type="button"
                          disabled={saving}
                          aria-label={`${busy ? "Switch to" : "Start"} ${item.title}`}
                          onClick={() => startTask(item)}
                        >
                          {busy ? "Switch to this task" : spentLabel(item.spentSeconds) ? "Continue" : "Start"}
                        </button>
                      )}
                    </li>
                  ))}
                  {internalWork.map((activity) => (
                    <li key={activity.id} className="card p-4">
                      <p className="text-lg font-semibold leading-snug">{activity.name}</p>
                      <p className="mt-1 text-sm text-muted">Not billed to a client</p>
                      <button
                        className="btn btn-ghost tap mt-3 min-h-14 w-full text-base"
                        type="button"
                        disabled={saving}
                        aria-label={`${busy ? "Switch to" : "Start"} ${activity.name}`}
                        onClick={() => void run("/tracking/tasks/switch", { badge, activityCode: activity.code })}
                      >
                        {busy ? "Switch to this" : "Start"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
      )}
      {context && checkedIn && !onMeal && (working || paused) ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-black/10 bg-paper/95 px-4 pb-5 pt-3 backdrop-blur">
          <div className="mx-auto max-w-lg space-y-2">
            {working && choosingPause && !confirmEnd ? (
              <PauseReasonPicker
                saving={saving}
                onCancel={() => setChoosingPause(false)}
                onPause={(reason) => {
                  void run("/tracking/tasks/pause", { badge, reason }).then((done) => {
                    if (done) setChoosingPause(false);
                  });
                }}
              />
            ) : null}
            {working && !choosingPause && !confirmEnd ? (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn btn-ghost tap min-h-14 text-base" type="button" disabled={saving} onClick={() => setChoosingPause(true)}>
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
          </div>
        </div>
      ) : null}
    </main>
  );
}

function PackPanel({
  badge,
  run,
}: {
  badge: string;
  run: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [orderNumber, setOrderNumber] = useState("");
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run("/tracking/packing", {
          orderNumber,
          badge,
          units: 1,
        });
      }}
    >
      <Field label="Order you just packed">
        <input className="field" required value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} placeholder="PK-10021" />
      </Field>
      <button className="btn btn-primary tap w-full" type="submit">
        I finished this order
      </button>
    </form>
  );
}

function PickPanel({
  badge,
  run,
}: {
  badge: string;
  run: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [sku, setSku] = useState("");
  const [batchCode, setBatchCode] = useState("");
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run("/tracking/picking", { badge, batchCode, sku, qty: 1 });
      }}
    >
      <Field label="Batch">
        <input className="field" required value={batchCode} onChange={(event) => setBatchCode(event.target.value)} />
      </Field>
      <Field label="SKU">
        <input className="field" required value={sku} onChange={(event) => setSku(event.target.value)} placeholder="SKU-TEE" />
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
    return <p className="card p-4 text-sm text-muted">No open carrier bin.</p>;
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
      <Field label="Carrier bin">
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
        Put it in the bin
      </button>
    </form>
  );
}
