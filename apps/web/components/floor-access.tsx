"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Field, Flash, Notice, Panel, SkeletonList, Spinner, timeAgo, useResource } from "@/components/ui";
import { api, ApiError, canManage, post } from "@/lib/api";

type Access = { allowed: boolean; approved: boolean; name: string | null };
type Device = { id: string; name: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null; current: boolean };

/** Shows the floor screens only on an approved device or to a signed-in floor user. */
export function FloorGate({ children }: { children: React.ReactNode }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [failed, setFailed] = useState(false);

  const check = useCallback(() => {
    setFailed(false);
    void api<Access>("/tracking/floor-devices/me")
      .then(setAccess)
      .catch(() => setFailed(true));
  }, []);

  useEffect(check, [check]);

  if (access?.allowed) return <>{children}</>;
  return (
    <main className="grid min-h-screen place-items-center px-4 py-8">
      <div className="card w-full max-w-md space-y-4 p-6 text-center">
        {failed ? (
          <>
            <h1 className="text-xl font-semibold">Could not check this device</h1>
            <p className="text-sm text-muted">Check the connection and try again.</p>
            <button className="btn btn-primary w-full" type="button" onClick={check}>
              Try again
            </button>
          </>
        ) : !access ? (
          <Spinner label="Checking this device" />
        ) : (
          <>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Floor access</p>
            <h1 className="text-2xl font-semibold">This device is not approved</h1>
            <p className="text-sm leading-6 text-muted">Floor scans only work on approved warehouse devices. A manager can approve this one in a few seconds.</p>
            <Link className="btn btn-primary w-full" href="/floor-devices">
              Manager: approve this device
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

export function FloorDevicesPanel() {
  const user = useSession();
  const manage = canManage(user?.role);
  const devices = useResource<Device[]>(manage ? "/tracking/floor-devices" : null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>(path, body);
      setMessage(result.message);
      devices.reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that device.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!user) return <SkeletonList rows={2} />;
  if (!manage) return <Notice tone="bad">Only an owner or warehouse manager can approve floor devices.</Notice>;

  const active = (devices.data ?? []).filter((device) => !device.revokedAt);
  const thisDevice = active.find((device) => device.current);

  return (
    <div className="space-y-4">
      <Flash message={message} error={error} />
      {devices.error ? <Notice tone="bad">{devices.error}</Notice> : null}
      <section className="card p-4 sm:p-5">
        <h2 className="font-semibold">This device</h2>
        {thisDevice ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="ok" dot>Approved</Badge>
            <span className="text-sm">{thisDevice.name}</span>
            <Link className="text-sm font-medium text-moss hover:underline" href="/phone">
              Open floor phone
            </Link>
            <Link className="text-sm font-medium text-moss hover:underline" href="/gate">
              Open QR gate
            </Link>
          </div>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act("/tracking/floor-devices", { name }).then((saved) => {
                if (saved) setName("");
              });
            }}
          >
            <div className="min-w-0 flex-1 basis-56">
              <Field label="Device name" hint="Do this on the phone, kiosk, or gate you want to approve.">
                <input className="field" required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="Front gate tablet" />
              </Field>
            </div>
            <button className="btn btn-primary mb-6" type="submit" disabled={busy}>
              Approve this device
            </button>
          </form>
        )}
      </section>
      <Panel title="Approved devices" count={active.length}>
        {devices.loading && !devices.data ? <div className="p-4"><SkeletonList rows={2} /></div> : null}
        {devices.data && active.length === 0 ? <EmptyRow title="No devices approved yet">Floor phones and QR gates stay locked until a manager approves them.</EmptyRow> : null}
        <ul className="divide-y divide-black/5">
          {active.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {device.name}
                  {device.current ? <Badge tone="ok">This device</Badge> : null}
                </p>
                <p className="text-xs text-muted">Last used {device.lastSeenAt ? timeAgo(device.lastSeenAt).toLowerCase() : "never"}</p>
              </div>
              <button
                className="btn btn-ghost btn-danger btn-sm"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove ${device.name}? It will stop recording floor work right away.`)) void act(`/tracking/floor-devices/${device.id}/revoke`, {});
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
