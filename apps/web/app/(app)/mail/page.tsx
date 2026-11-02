"use client";

import Link from "next/link";
import { useSession } from "@/components/shell";
import { Notice, PageTitle, useResource } from "@/components/ui";

type Status = { gmail: boolean; warehance: boolean; slack: boolean };

export default function MailPage() {
  const user = useSession();
  const allowed = user?.role === "owner" || user?.role === "warehouse_manager";
  const { data, error, loading } = useResource<Status>(allowed ? "/mail/status" : null);

  if (!user) return <p className="text-muted">Loading…</p>;
  if (!allowed) return <Notice tone="bad">Mail is for the warehouse manager.</Notice>;

  const ready = data?.gmail && data.warehance && data.slack;

  return (
    <div>
      <PageTitle
        kicker="Mail"
        title="Inbox"
        detail="Letters from clients will land here after Gmail is connected. Nothing sends until a person approves the draft."
      />
      {loading ? <p className="text-muted">Loading…</p> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {data && !ready ? (
        <section className="card max-w-xl space-y-3 p-5">
          <p>Connect the missing pieces in Settings before the inbox can work.</p>
          <ul className="space-y-1 text-sm">
            <li>{data.gmail ? "Gmail is connected." : "Gmail is not connected."}</li>
            <li>{data.warehance ? "Warehance bot is connected." : "Warehance bot is not connected."}</li>
            <li>{data.slack ? "Slack is connected." : "Slack is not connected."}</li>
          </ul>
          {user.role === "owner" ? (
            <Link className="btn btn-primary" href="/settings">
              Open Settings
            </Link>
          ) : (
            <p className="text-sm text-muted">Ask the owner to connect them.</p>
          )}
        </section>
      ) : null}
      {ready ? (
        <section className="card max-w-xl p-5">
          <p>No letters yet. New mail to the warehouse mailbox will show up here.</p>
        </section>
      ) : null}
    </div>
  );
}
