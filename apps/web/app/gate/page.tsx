"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/ui";
import { api, ApiError, post } from "@/lib/api";
import { badgeFromScan } from "@/lib/qr";

type Action = "in" | "out";

const PLACES = ["Front gate", "Dock", "Packing", "Picking", "Receiving", "Unloading", "Sorting"] as const;
const PLACE_KEY = "oe_gate_place";

type Fix = { latitude: number; longitude: number; accuracy: number; capturedAt: number };

function readPosition() {
  return new Promise<Fix | null>((resolve) => {
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

export default function GatePage() {
  const [action, setAction] = useState<Action>("in");
  const [place, setPlace] = useState<(typeof PLACES)[number]>("Front gate");
  const [scan, setScan] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [gpsLabel, setGpsLabel] = useState("Location check is on. Reading this device…");
  const [siteReady, setSiteReady] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastScan = useRef<{ code: string; at: number } | null>(null);
  const scannerRef = useRef<{ stop: () => Promise<void> } | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(PLACE_KEY);
    if (saved && PLACES.includes(saved as (typeof PLACES)[number])) {
      setPlace(saved as (typeof PLACES)[number]);
    }
    inputRef.current?.focus();
    void api<{ ready: boolean }>("/tracking/gate")
      .then((status) => setSiteReady(status.ready))
      .catch(() => setSiteReady(null));
    void readPosition().then((fix) => {
      setGpsLabel(
        fix
          ? "Location check is on. This device has a fresh position."
          : "Location check is on. This device has not shared a position.",
      );
    });
    return () => {
      void scannerRef.current?.stop().catch(() => undefined);
    };
  }, []);

  function choosePlace(next: (typeof PLACES)[number]) {
    setPlace(next);
    window.localStorage.setItem(PLACE_KEY, next);
  }

  async function submit(raw: string) {
    const badge = badgeFromScan(raw);
    if (!badge || pending) return;
    const now = Date.now();
    if (lastScan.current && lastScan.current.code === badge && now - lastScan.current.at < 2500) return;
    lastScan.current = { code: badge, at: now };
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const fix = await readPosition();
      if (!fix) {
        lastScan.current = null;
        setGpsLabel("Location check is on. This device has not shared a position.");
        setError("This device must share its location. A scan without it is not recorded.");
        return;
      }
      setGpsLabel("Location check is on. This device has a fresh position.");
      const result = await post<{ message: string }>("/tracking/clock", {
        badge,
        action,
        source: "qr",
        place,
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
        capturedAt: fix.capturedAt,
      });
      setMessage(result.message);
      setScan("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That ID could not be recorded.");
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }

  async function startCamera() {
    setCameraError(null);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          void submit(decoded);
        },
        () => undefined,
      );
      setCameraOn(true);
    } catch {
      setCameraOn(false);
      setCameraError("The camera did not start. A USB scanner can still type the ID into the box.");
    }
  }

  async function stopCamera() {
    try {
      await scannerRef.current?.stop();
    } catch {
      /* already stopped */
    }
    scannerRef.current = null;
    setCameraOn(false);
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-8">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">QR gate</p>
          <h1 className="mt-1 text-3xl font-semibold">Check in</h1>
          <p className="mt-2 text-sm text-muted">
            Scan an employee QR ID. The device location is checked every time. A scan away from the warehouse is refused.
          </p>
        </div>
        {siteReady === false ? (
          <Notice tone="bad">A supervisor still needs to mark the warehouse. Until then, scans are refused.</Notice>
        ) : null}
        {message ? <Notice tone="ok">{message}</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="grid grid-cols-2 gap-3">
          <button
            className={`btn tap h-20 text-lg ${action === "in" ? "btn-primary" : "btn-ghost"}`}
            type="button"
            onClick={() => setAction("in")}
          >
            Check in
          </button>
          <button
            className={`btn tap h-20 text-lg ${action === "out" ? "btn-warn" : "btn-ghost"}`}
            type="button"
            onClick={() => setAction("out")}
          >
            Check out
          </button>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted">Gate location</span>
          <select
            className="field"
            value={place}
            aria-label="Gate location"
            onChange={(event) => choosePlace(event.target.value as (typeof PLACES)[number])}
          >
            {PLACES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted">{gpsLabel}</span>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(scan);
          }}
        >
          <input
            ref={inputRef}
            className="field text-center font-mono text-xl"
            value={scan}
            onChange={(event) => setScan(event.target.value)}
            placeholder="Scan ID"
            aria-label="Scan ID"
            autoComplete="off"
          />
          <button className="btn btn-primary mt-3 w-full" type="submit" disabled={pending}>
            Record scan
          </button>
        </form>
        <div id="qr-reader" className="overflow-hidden rounded-xl bg-black/5" />
        {cameraError ? <Notice tone="bad">{cameraError}</Notice> : null}
        {cameraOn ? (
          <button className="btn btn-ghost w-full" type="button" onClick={() => void stopCamera()}>
            Stop camera
          </button>
        ) : (
          <button className="btn btn-ghost w-full" type="button" onClick={() => void startCamera()}>
            Use camera
          </button>
        )}
        <p className="text-center text-sm text-muted">
          <Link className="text-moss" href="/checkin">
            Today’s check-ins
          </Link>
          {" · "}
          <Link className="text-moss" href="/warehouse">
            Floor phone
          </Link>
        </p>
      </div>
    </main>
  );
}
