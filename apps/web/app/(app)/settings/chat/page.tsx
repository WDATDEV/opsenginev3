"use client";

import { useState } from "react";
import { hasSection } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, Notice, PageTitle, SkeletonList, useResource } from "@/components/ui";

type ChatLogThread = {
  id: string;
  title: string;
  kind: string;
  clientName: string | null;
  retrieved: number;
  changed: number;
  lastAt: string;
};

type ChatLogEvent = {
  id: string;
  action: string;
  tool: string;
  kind: string;
  recordId: string;
  label: string;
  payload: Record<string, unknown>;
  outcome: string;
  error: string | null;
  createdAt: string;
};

export default function SettingsChatLogPage() {
  const user = useSession();
  const allowed = hasSection(user, "settings") && user?.role === "owner";
  const { data, error, loading } = useResource<{ threads: ChatLogThread[] }>(allowed ? "/settings/chat-warehance" : null);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<{ events: ChatLogEvent[] }>(allowed && openId ? `/settings/chat-warehance/${openId}` : null);

  if (!user) return <SkeletonList rows={2} />;
  if (!allowed) return <Notice tone="bad">Only the owner can open the chat Warehance log.</Notice>;

  return (
    <div className="max-w-3xl">
      <PageTitle
        kicker="Settings"
        title="Chat log"
        detail="What Chat looked up in Warehance, and what the owner confirmed. Grouped by chat."
      />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {loading && !data ? <SkeletonList rows={3} /> : null}
      {data && data.threads.length === 0 ? (
        <EmptyState title="No Warehance chat records yet">Lookups and confirmed changes will show here after the next Chat turn.</EmptyState>
      ) : null}
      <div className="space-y-3">
        {data?.threads.map((thread) => (
          <article key={thread.id} className="card space-y-3 p-5">
            <button className="flex w-full items-start justify-between gap-3 text-left" type="button" onClick={() => setOpenId(openId === thread.id ? null : thread.id)}>
              <div className="min-w-0">
                <p className="truncate font-medium">{thread.title}</p>
                <p className="mt-1 text-xs text-muted">
                  {thread.clientName ? `${thread.clientName} · ` : ""}
                  {when(thread.lastAt)}
                </p>
              </div>
              <div className="flex flex-none flex-wrap justify-end gap-2">
                <Badge>{thread.retrieved} retrieved</Badge>
                <Badge tone={thread.changed > 0 ? "warn" : "neutral"}>{thread.changed} changed</Badge>
              </div>
            </button>
            {openId === thread.id ? <ChatWarehanceEvents loading={detail.loading} error={detail.error} events={detail.data?.events ?? []} /> : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function ChatWarehanceEvents({ loading, error, events }: { loading: boolean; error: string | null; events: ChatLogEvent[] }) {
  if (loading && events.length === 0) return <p className="text-sm text-muted">Loading records…</p>;
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (events.length === 0) return <p className="text-sm text-muted">Nothing stored for this chat yet.</p>;
  return (
    <ul className="divide-y divide-black/10 border-t border-black/10">
      {events.map((event) => (
        <li key={event.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={event.action === "change" ? "warn" : "neutral"}>{event.action === "change" ? "Changed" : "Retrieved"}</Badge>
            <Badge tone={event.outcome === "applied" || event.outcome === "ok" ? "ok" : event.outcome === "failed" || event.outcome === "rejected" ? "bad" : "neutral"}>
              {event.outcome}
            </Badge>
            <span className="text-sm font-medium">{event.label}</span>
            <span className="text-xs text-muted">{event.tool}</span>
            <span className="ml-auto text-xs text-muted">{when(event.createdAt)}</span>
          </div>
          {event.error ? <p className="mt-1 text-sm text-rust">{event.error}</p> : null}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted">Record</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/[0.04] p-2 text-xs leading-5">{JSON.stringify(event.payload, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function when(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
