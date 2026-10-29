"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Gaylord = {
  id: string;
  code: string;
  carrier: string;
  status: string;
  scans: {
    trackingNumber: string;
    method: string;
    reason: string | null;
    scannedAt: string;
    employeeName: string;
    deviceCode: string | null;
  }[];
};

export default function SortingPage() {
  const board = useResource<Gaylord[]>("/tracking/sorting");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [carrier, setCarrier] = useState("fedex");
  const [gaylordCode, setGaylordCode] = useState("GL-USPS-1");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [badge, setBadge] = useState("B-10449");
  const [method, setMethod] = useState<"scan" | "manual_place">("scan");
  const [reason, setReason] = useState("");

  async function act(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, body);
      setMessage(result.message ?? "Saved.");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update sorting.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Sorting"
        title="Scan into the gaylord"
        detail="USPS, UPS, FedEx, DHL, and other carrier gaylords take a scan. Placing a package without a scan needs a reason."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManage(user?.role) ? (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <form
            className="card space-y-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void act("/tracking/sorting/gaylords", { code, carrier });
            }}
          >
            <h2 className="font-semibold">Open a gaylord</h2>
            <Field label="Code">
              <input className="field" value={code} onChange={(event) => setCode(event.target.value)} placeholder="GL-FEDEX-1" />
            </Field>
            <Field label="Carrier">
              <select className="field" value={carrier} onChange={(event) => setCarrier(event.target.value)}>
                {["usps", "ups", "fedex", "dhl", "other"].map((item) => (
                  <option key={item} value={item}>
                    {item.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn btn-primary" type="submit">
              Open gaylord
            </button>
          </form>
          <form
            className="card space-y-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void act("/tracking/sorting/scan", {
                gaylordCode,
                trackingNumber,
                badge,
                method,
                reason: method === "manual_place" ? reason : undefined,
              });
            }}
          >
            <h2 className="font-semibold">Place a package</h2>
            <Field label="Gaylord">
              <select className="field" value={gaylordCode} onChange={(event) => setGaylordCode(event.target.value)}>
                {board.data?.filter((item) => item.status === "open").map((item) => (
                  <option key={item.id} value={item.code}>
                    {item.code} · {item.carrier.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tracking number">
              <input className="field font-mono" value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} />
            </Field>
            <Field label="Badge">
              <input className="field font-mono" value={badge} onChange={(event) => setBadge(event.target.value)} />
            </Field>
            <Field label="Method">
              <select className="field" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                <option value="scan">Scanned into the gaylord</option>
                <option value="manual_place">Placed without a scan</option>
              </select>
            </Field>
            {method === "manual_place" ? (
              <Field label="Why there is no scan">
                <input className="field" value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
            ) : null}
            <button className="btn btn-primary" type="submit">
              Record placement
            </button>
          </form>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {board.data?.map((gaylord) => (
          <article key={gaylord.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono">{gaylord.code}</p>
                <h2 className="text-xl font-semibold">{gaylord.carrier.toUpperCase()}</h2>
                <p className="text-sm text-muted">
                  {gaylord.status} · {gaylord.scans.length} packages
                </p>
              </div>
              {canManage(user?.role) && gaylord.status === "open" ? (
                <button className="btn btn-ghost" type="button" onClick={() => act(`/tracking/sorting/${gaylord.id}/close`, {})}>
                  Close
                </button>
              ) : null}
            </div>
            <ul className="mt-3 space-y-2 text-sm">
              {gaylord.scans.map((scan) => (
                <li key={scan.trackingNumber}>
                  <span className="font-mono">{scan.trackingNumber}</span> · {scan.employeeName} ·{" "}
                  {scan.method === "scan" ? "scanned" : `placed without scan (${scan.reason})`} · {when(scan.scannedAt)}
                </li>
              ))}
              {gaylord.scans.length === 0 ? <li className="text-muted">Empty.</li> : null}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}
