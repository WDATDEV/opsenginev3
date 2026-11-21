"use client";

import { useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Field, Flash, Notice, PageTitle, SearchBox, Segmented, SkeletonList, Stat, StatGrid, isToday, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Gaylord = {
  id: string;
  code: string;
  carrier: string;
  clientId: string | null;
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

type View = "open" | "closed" | "all";

const VIEWS = [
  ["open", "Open bins"],
  ["closed", "Closed"],
  ["all", "All"],
] as const;

const SCAN_PREVIEW = 5;

export function SortingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Gaylord[]>("/tracking/sorting");
  const user = useSession();
  const manage = canManage(user?.role);
  const trackingInput = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [carrier, setCarrier] = useState("fedex");
  const [gaylordCode, setGaylordCode] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [badge, setBadge] = useState("");
  const [method, setMethod] = useState<"scan" | "manual_place">("scan");
  const [reason, setReason] = useState("");
  const [view, setView] = useState<View>("open");
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
      setError(err instanceof ApiError ? err.message : "Could not update sorting.");
      return false;
    }
  }

  const bins = (board.data ?? []).filter((gaylord) => !client || gaylord.clientId === client.id);
  const openBins = bins.filter((item) => item.status === "open");
  const selectedBin = openBins.some((item) => item.code === gaylordCode) ? gaylordCode : (openBins[0]?.code ?? "");
  const scans = bins.flatMap((bin) => bin.scans);
  const todayScans = scans.filter((scan) => isToday(scan.scannedAt));
  const query = search.trim().toLowerCase();
  const list = bins.filter(
    (bin) =>
      (view === "all" || (view === "open") === (bin.status === "open")) &&
      (!query || `${bin.code} ${bin.carrier} ${bin.scans.map((scan) => scan.trackingNumber).join(" ")}`.toLowerCase().includes(query)),
  );

  return (
    <div>
      <PageTitle
        kicker="Sorting"
        title={client ? `Sorting for ${client.name}` : "Scan into the carrier bin"}
        detail="Open a carrier bin, then scan packages in. A package placed without a scan needs a reason."
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <StatGrid>
        <Stat label="Open bins" value={openBins.length} tone="ok" />
        <Stat label="Packages today" value={todayScans.length.toLocaleString()} />
        <Stat label="No-scan today" value={todayScans.filter((scan) => scan.method !== "scan").length} tone={todayScans.some((scan) => scan.method !== "scan") ? "warn" : undefined} />
        <Stat label="Packages, all time" value={scans.length.toLocaleString()} />
      </StatGrid>

      <div className={`grid items-start gap-5 ${manage ? "lg:grid-cols-[21rem_minmax(0,1fr)]" : ""}`}>
        {manage ? (
          <div className="space-y-4 lg:sticky lg:top-6">
            <form
              className="card space-y-3 p-4 sm:p-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!selectedBin) {
                  setMessage(null);
                  setError("Open a carrier bin first.");
                  return;
                }
                void act("/tracking/sorting/scan", {
                  gaylordCode: selectedBin,
                  trackingNumber,
                  badge,
                  method,
                  reason: method === "manual_place" ? reason : undefined,
                }).then((saved) => {
                  if (!saved) return;
                  setTrackingNumber("");
                  setReason("");
                  setMethod("scan");
                  trackingInput.current?.focus();
                });
              }}
            >
              <h2 className="font-semibold">Place a package</h2>
              <Field label="Carrier bin">
                <select className="field" value={selectedBin} disabled={openBins.length === 0} onChange={(event) => setGaylordCode(event.target.value)}>
                  {openBins.length === 0 ? <option value="">No open bins</option> : null}
                  {openBins.map((item) => (
                    <option key={item.id} value={item.code}>
                      {item.code} · {item.carrier.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Badge" hint="Bin and badge stay filled in for the next package.">
                <input className="field font-mono" required autoComplete="off" value={badge} onChange={(event) => setBadge(event.target.value)} placeholder="Scan the badge" />
              </Field>
              <Field label="Tracking number">
                <input ref={trackingInput} className="field font-mono" required autoComplete="off" value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} placeholder="Scan the package" />
              </Field>
              <Field label="Method">
                <select className="field" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                  <option value="scan">Scanned into the bin</option>
                  <option value="manual_place">Placed without a scan</option>
                </select>
              </Field>
              {method === "manual_place" ? (
                <Field label="Why there is no scan">
                  <input className="field" required value={reason} onChange={(event) => setReason(event.target.value)} />
                </Field>
              ) : null}
              <button className="btn btn-primary w-full" type="submit" disabled={openBins.length === 0}>
                Record placement
              </button>
            </form>
            <form
              className="card space-y-3 p-4 sm:p-5"
              onSubmit={(event) => {
                event.preventDefault();
                void act("/tracking/sorting/gaylords", { code, carrier, ...(client ? { clientId: client.id } : {}) }).then((saved) => {
                  if (!saved) return;
                  setGaylordCode(code.trim().toUpperCase());
                  setCode("");
                });
              }}
            >
              <h2 className="font-semibold">Open a carrier bin</h2>
              <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3">
                <Field label="Code">
                  <input className="field font-mono" required value={code} onChange={(event) => setCode(event.target.value)} placeholder="GL-FEDEX-1" />
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
              </div>
              <button className="btn w-full" type="submit">
                Open bin
              </button>
            </form>
          </div>
        ) : null}

        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented label="Show bins" options={VIEWS} value={view} onChange={setView} />
            <SearchBox value={search} onChange={setSearch} label="Search bins" placeholder="Search bin or tracking" />
          </div>
          {board.loading && !board.data ? <SkeletonList rows={3} /> : null}
          {board.data && list.length === 0 ? (
            <div className="card">
              <EmptyRow title={query ? "Nothing matches that search" : view === "closed" ? "No closed bins" : "No open bins"}>{query ? null : "Carrier bins appear here once they are opened."}</EmptyRow>
            </div>
          ) : null}
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {list.map((gaylord) => (
              <BinCard
                key={gaylord.id}
                gaylord={gaylord}
                manage={manage}
                onClose={() => {
                  if (window.confirm(`Close bin ${gaylord.code}? No more packages can be placed in it.`)) void act(`/tracking/sorting/${gaylord.id}/close`, {});
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BinCard({ gaylord, manage, onClose }: { gaylord: Gaylord; manage: boolean; onClose: () => void }) {
  const [all, setAll] = useState(false);
  const open = gaylord.status === "open";
  const scans = all ? gaylord.scans : gaylord.scans.slice(0, SCAN_PREVIEW);
  return (
    <article className="card min-w-0 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-mono font-semibold">{gaylord.code}</h3>
            <Badge tone={open ? "ok" : "neutral"} dot>
              {open ? "Open" : "Closed"}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {gaylord.carrier.toUpperCase()} · {gaylord.scans.length} {gaylord.scans.length === 1 ? "package" : "packages"}
          </p>
        </div>
        {manage && open ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      {gaylord.scans.length === 0 ? <p className="mt-3 text-sm text-muted">Empty.</p> : null}
      <ul className="mt-3 divide-y divide-black/5 text-sm">
        {scans.map((scan) => (
          <li key={scan.trackingNumber} className="py-2">
            <p className="truncate font-mono text-[13px]">{scan.trackingNumber}</p>
            <p className="mt-0.5 text-xs text-muted">
              {scan.employeeName} · {when(scan.scannedAt)}
              {scan.method === "scan" ? "" : ` · no scan: ${scan.reason ?? "no reason"}`}
            </p>
          </li>
        ))}
      </ul>
      {gaylord.scans.length > SCAN_PREVIEW ? (
        <button className="mt-1 text-sm font-medium text-moss hover:underline" type="button" onClick={() => setAll((value) => !value)}>
          {all ? "Show less" : `Show all ${gaylord.scans.length}`}
        </button>
      ) : null}
    </article>
  );
}
