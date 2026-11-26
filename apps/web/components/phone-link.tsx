"use client";

// A manager gives one employee a one-time link. Opening it on their own phone ties that phone to them,
// so they can check in, run their tasks, and see their past records there, for themselves only.

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { Notice, timeAgo } from "@/components/ui";
import { api, ApiError, post } from "@/lib/api";

type Phone = { id: string; linked: boolean; createdAt: string; claimedAt: string | null; lastSeenAt: string | null; expiresAt: string | null };

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function PhoneLink({ person, onClose }: { person: { id: string; name: string; active: boolean }; onClose: () => void }) {
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [link, setLink] = useState<{ url: string; qr: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void api<Phone[]>(`/tracking/phones/employee/${person.id}`)
      .then(setPhones)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this person's phones."));
  }, [person.id]);

  useEffect(reload, [reload]);

  async function makeLink() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setCopied(false);
    try {
      const result = await post<{ path: string; expiresAt: string }>(`/tracking/phones/link/${person.id}`, {});
      const url = `${window.location.origin}${result.path}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: "M" });
      setLink({ url, qr, expiresAt: result.expiresAt });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not make a phone link.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(phone: Phone) {
    const question = phone.linked
      ? `Remove this phone? It stops recording ${person.name}'s time right away.`
      : "Cancel this phone link? It will no longer work.";
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ message: string }>(`/tracking/phones/${phone.id}/revoke`, {});
      setMessage(phone.linked ? result.message : "That link is cancelled.");
      if (!phone.linked) setLink(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove that phone.");
    } finally {
      setBusy(false);
    }
  }

  const linked = (phones ?? []).filter((phone) => phone.linked);
  const waiting = (phones ?? []).filter((phone) => !phone.linked);

  return (
    <div className="col-span-full mt-2 space-y-3 rounded-xl border border-black/10 bg-white/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{person.name}&apos;s phone</p>
          <p className="text-sm text-muted">
            Let {person.name} use the floor phone on their own phone. They can only check themselves in and out, run their own tasks, and
            see their own past records.
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}

      {link ? (
        <div className="flex flex-wrap items-start gap-4 rounded-lg bg-moss/5 p-3">
          <img src={link.qr} alt={`Phone link for ${person.name}`} width={160} height={160} className="rounded-lg bg-white" />
          <div className="min-w-0 flex-1 basis-56 space-y-2 text-sm">
            <p className="font-medium">Have {person.name} scan this with their phone camera.</p>
            <p className="text-muted">
              Or send them the link. It works once, on one phone, until {timeLabel(link.expiresAt)}. Don&apos;t share it with anyone else.
            </p>
            <div className="flex gap-2">
              <input className="field min-w-0 flex-1 font-mono text-xs" readOnly value={link.url} aria-label="Phone link" onFocus={(event) => event.target.select()} />
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(link.url).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="btn btn-primary btn-sm" type="button" disabled={busy || !person.active} onClick={() => void makeLink()}>
          {linked.length ? "Link another phone" : "Make a phone link"}
        </button>
      )}
      {!person.active ? <p className="text-sm text-muted">Reactivate {person.name} to give them a phone link.</p> : null}

      {phones === null ? (
        <p className="text-sm text-muted">Loading phones…</p>
      ) : linked.length === 0 && waiting.length === 0 ? (
        <p className="text-sm text-muted">No phone linked yet.</p>
      ) : (
        <ul className="divide-y divide-black/5 text-sm">
          {linked.map((phone) => (
            <li key={phone.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                Phone linked {phone.claimedAt ? timeAgo(phone.claimedAt).toLowerCase() : ""}
                <span className="text-muted"> · last used {phone.lastSeenAt ? timeAgo(phone.lastSeenAt).toLowerCase() : "never"}</span>
              </span>
              <button className="btn btn-ghost btn-danger btn-sm" type="button" disabled={busy} onClick={() => void remove(phone)}>
                Remove
              </button>
            </li>
          ))}
          {waiting.map((phone) => (
            <li key={phone.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-muted">Link not opened yet{phone.expiresAt ? ` · works until ${timeLabel(phone.expiresAt)}` : ""}</span>
              <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void remove(phone)}>
                Cancel link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
