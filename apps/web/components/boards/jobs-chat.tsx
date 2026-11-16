"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Notice, Spinner } from "@/components/ui";
import { ApiError, api, canManageJobs, post } from "@/lib/api";

type JobChange = {
  kind: "create_job" | "assign_people";
  clientName: string;
  jobReference: string;
  title: string;
  billBasis: string | null;
  people: { employeeId: string; name: string }[];
  summary: string;
  status: "proposed" | "applying" | "applied" | "rejected";
  expiresAt: string;
  result: string | null;
  error: string | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "working" | "done" | "failed";
  error: string | null;
  lookups: { tool: string; summary: string }[];
  jobChange: JobChange | null;
  createdAt: string;
};

type Detail = { thread: { id: string }; messages: ChatMessage[] };

function reason(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export function JobsChat({ clientId, onChanged }: { clientId?: string; onChanged: () => void }) {
  const user = useSession();
  const manage = canManageJobs(user?.role);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const path = clientId ? `/jobs/chat?clientId=${encodeURIComponent(clientId)}` : "/jobs/chat";

  const load = useCallback(async () => {
    try {
      const next = await api<Detail>(path);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(reason(err, "Could not open jobs chat."));
    }
  }, [path]);

  useEffect(() => {
    void load();
    void api<{ claude: boolean }>("/jobs/chat/ready")
      .then((row) => setReady(row.claude))
      .catch(() => setReady(false));
  }, [load]);

  const working = Boolean(detail?.messages.some((message) => message.status === "working"));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [working, load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, working]);

  async function submit() {
    const asked = text.trim();
    if (!asked || sending || working || !manage) return;
    setSending(true);
    setError(null);
    try {
      const next = await post<Detail>("/jobs/chat", { text: asked, clientId: clientId ?? null });
      setDetail(next);
      setText("");
    } catch (err) {
      setError(reason(err, "Could not send that."));
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="card flex min-h-[28rem] flex-col p-4">
      <h2 className="text-lg font-semibold">Jobs chat</h2>
      <p className="mt-1 text-sm text-muted">
        Ask to open a job or assign people
        {clientId ? " for this client" : ""}. Claude prepares a card. Confirm is what saves it.
      </p>
      {ready === false ? <Notice tone="bad">Add the Claude API key in Settings to use jobs chat.</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {detail?.messages.length ? null : <p className="text-sm text-muted">Try: Open HG-100 inbound for Harbor Goods and assign Ada.</p>}
        {detail?.messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <p className={`text-sm ${message.role === "user" ? "font-medium" : ""}`}>
              {message.role === "user" ? "You · " : ""}
              {message.status === "working" ? <Spinner label="Looking that up" /> : message.content}
            </p>
            {message.error ? <p className="text-xs text-clay">{message.error}</p> : null}
            {message.jobChange ? (
              <JobCard change={message.jobChange} messageId={message.id} canConfirm={manage} onDone={() => void load().then(onChanged)} />
            ) : null}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {manage ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            className="field flex-1"
            value={text}
            disabled={sending || working || ready === false}
            onChange={(event) => setText(event.target.value)}
            placeholder="Open a job and assign the crew"
          />
          <button className="btn btn-primary" type="submit" disabled={sending || working || ready === false || !text.trim()}>
            {sending ? <Spinner /> : "Ask"}
          </button>
        </form>
      ) : (
        <p className="mt-3 text-xs text-muted">You can read this chat. Someone who manages jobs confirms the cards.</p>
      )}
    </aside>
  );
}

function JobCard({
  change,
  messageId,
  canConfirm,
  onDone,
}: {
  change: JobChange;
  messageId: string;
  canConfirm: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = change.status === "proposed" && new Date(change.expiresAt).getTime() < Date.now();

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await post(`/jobs/chat/messages/${messageId}/confirm`, {});
      onDone();
    } catch (err) {
      setError(reason(err, "Could not save that job."));
    } finally {
      setBusy(false);
    }
  }

  const title = change.kind === "create_job" ? `Open ${change.jobReference}` : `Assign to ${change.jobReference}`;

  return (
    <div className="space-y-2 rounded-xl border border-moss/30 p-3 text-sm">
      <p className="font-medium">{title}</p>
      <p className="text-xs text-muted">{change.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Client</dt>
        <dd>{change.clientName}</dd>
        {change.kind === "create_job" ? (
          <>
            <dt className="text-muted">Title</dt>
            <dd>{change.title}</dd>
            <dt className="text-muted">Bill by</dt>
            <dd>{change.billBasis ?? "mixed"}</dd>
          </>
        ) : null}
        <dt className="text-muted">People</dt>
        <dd>{change.people.length ? change.people.map((person) => person.name).join(", ") : "Nobody yet"}</dd>
      </dl>
      {change.status === "applied" ? <p className="text-xs text-moss">{change.result ?? "Saved."}</p> : null}
      {change.status === "rejected" || change.error ? <p className="text-xs text-clay">{change.error}</p> : null}
      {change.status === "applying" ? <p className="text-xs text-muted">Saving…</p> : null}
      {expired ? <p className="text-xs text-muted">This card expired. Ask again.</p> : null}
      {error ? <p className="text-xs text-clay">{error}</p> : null}
      {canConfirm && change.status === "proposed" && !expired ? (
        <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void confirm()}>
          {busy ? <Spinner /> : "Confirm"}
        </button>
      ) : null}
    </div>
  );
}
