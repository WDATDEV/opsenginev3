"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, post } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Notice, PageTitle, useResource } from "@/components/ui";

type Status = { gmail: boolean; warehance: boolean; slack: boolean };
type Letter = {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  body: string;
  receivedAt: string;
  clientId: string | null;
  status: string;
};

export default function MailPage() {
  const user = useSession();
  const allowed = user?.role === "owner" || user?.role === "warehouse_manager";
  const { data, error, loading } = useResource<Status>(allowed ? "/mail/status" : null);
  const letters = useResource<Letter[]>(allowed && data?.gmail ? "/mail/letters" : null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function checkNow() {
    setChecking(true);
    setProblem(null);
    try {
      await post("/mail/sync", {});
      letters.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not check the mailbox.");
    } finally {
      setChecking(false);
    }
  }

  if (!user) return <p className="text-muted">Loading…</p>;
  if (!allowed) return <Notice tone="bad">Mail is for the warehouse manager.</Notice>;

  const missing = data
    ? [
        data.gmail ? null : "Gmail",
        data.warehance ? null : "the Warehance bot",
        data.slack ? null : "Slack",
      ].filter(Boolean)
    : [];

  return (
    <div>
      <PageTitle
        kicker="Mail"
        title="Inbox"
        detail="Letters from the warehouse mailbox. Nothing is answered or sent until a person approves it."
      />
      {loading ? <p className="text-muted">Loading…</p> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {data && missing.length > 0 ? (
        <section className="card mb-4 max-w-3xl space-y-3 p-5">
          <p>
            Not connected yet: {missing.join(", ")}.
            {data.gmail ? " Letters still arrive, but replies need the rest." : " Connect Gmail before letters can arrive."}
          </p>
          {user.role === "owner" ? (
            <Link className="btn btn-primary" href="/settings">
              Open Settings
            </Link>
          ) : (
            <p className="text-sm text-muted">Ask the owner to connect them.</p>
          )}
        </section>
      ) : null}
      {data?.gmail ? (
        <div className="max-w-3xl space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted">New mail is checked every minute.</p>
            <button className="btn" type="button" disabled={checking} onClick={checkNow}>
              {checking ? "Checking" : "Check now"}
            </button>
          </div>
          {letters.error ? <Notice tone="bad">{letters.error}</Notice> : null}
          {letters.data && letters.data.length === 0 ? (
            <section className="card p-5">
              <p>No letters yet. Mail from the last 7 days appears here after the next check.</p>
            </section>
          ) : null}
          {letters.data?.map((letter) => (
            <section key={letter.id} className="card p-4">
              <button className="w-full text-left" type="button" onClick={() => setOpen(open === letter.id ? null : letter.id)}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{letter.subject || "(no subject)"}</p>
                    <p className="text-sm text-muted">
                      {letter.fromName ? `${letter.fromName} · ` : ""}
                      {letter.fromEmail}
                    </p>
                  </div>
                  <div className="text-right text-sm text-muted">
                    <p>{new Date(letter.receivedAt).toLocaleString()}</p>
                    <p>{letter.clientId ? "Matched" : "Unassigned"}</p>
                  </div>
                </div>
              </button>
              {open === letter.id ? <p className="mt-3 whitespace-pre-wrap border-t border-black/10 pt-3 text-sm">{letter.body || "(empty)"}</p> : null}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
