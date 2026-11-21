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
  notSaved?: string[];
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

function clock(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
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
  const box = useRef<HTMLTextAreaElement | null>(null);
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

  const workingId = detail?.messages.find((message) => message.status === "working")?.id ?? null;
  const working = Boolean(workingId);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [working, load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, working]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 120)}px`;
  }, [text]);

  async function cancelFetch() {
    if (!workingId || sending) return;
    setSending(true);
    setError(null);
    try {
      const next = await post<Detail>(
        clientId ? `/jobs/chat/messages/${workingId}/cancel?clientId=${encodeURIComponent(clientId)}` : `/jobs/chat/messages/${workingId}/cancel`,
        {},
      );
      setDetail(next);
    } catch (err) {
      setError(reason(err, "Could not stop that."));
    } finally {
      setSending(false);
    }
  }

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

  const blocked = sending || working || ready === false;

  return (
    <aside className="card flex min-h-[32rem] flex-col overflow-hidden">
      <div className="border-b border-black/10 px-4 py-3">
        <h2 className="text-lg font-semibold">Jobs chat</h2>
        <p className="mt-1 text-sm leading-5 text-muted">
          Ask to open a job or assign people
          {clientId ? " for this client" : ""}. Names must match Time tracking. Confirm is what saves it.
        </p>
      </div>
      {ready === false ? (
        <div className="px-4 pt-3">
          <Notice tone="bad">Add the Claude API key in Settings to use jobs chat.</Notice>
        </div>
      ) : null}
      {error ? (
        <div className="px-4 pt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {detail?.messages.length ? null : (
          <div className="rounded-xl bg-black/[0.03] px-3 py-3 text-sm leading-6 text-muted">
            Try: Open job HG-100 inbound for Harbor Goods and assign Ada Cole.
          </div>
        )}
        {detail?.messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex flex-col items-end gap-1">
              <p className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-moss px-3 py-2 text-sm leading-6 text-paper">{message.content}</p>
              <span className="px-1 text-[11px] text-muted">{clock(message.createdAt)}</span>
            </div>
          ) : (
            <div key={message.id} className="max-w-[92%] space-y-2">
              {message.status === "working" ? (
                <div className="rounded-2xl rounded-bl-md bg-black/[0.04] px-3 py-2 text-sm">
                  <span className="inline-flex items-center gap-2 text-muted">
                    <span className="chat-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    Looking that up…
                  </span>
                  <button className="btn btn-sm mt-2" type="button" onClick={() => void cancelFetch()}>
                    Cancel
                  </button>
                </div>
              ) : (
                <p className="whitespace-pre-wrap rounded-2xl rounded-bl-md bg-black/[0.04] px-3 py-2 text-sm leading-6">{message.content}</p>
              )}
              {message.error ? <p className="text-xs text-clay">{message.error}</p> : null}
              {message.jobChange ? (
                <JobCard change={message.jobChange} messageId={message.id} clientId={clientId} canConfirm={manage} onDone={() => void load().then(onChanged)} />
              ) : null}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      {manage ? (
        <form
          className="border-t border-black/10 px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={box}
              className="field min-h-[2.75rem] flex-1 resize-none overflow-hidden py-2.5"
              rows={1}
              value={text}
              disabled={blocked}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Open a job and assign the crew"
              aria-label="Jobs chat message"
            />
            {working ? (
              <button className="btn" type="button" onClick={() => void cancelFetch()} disabled={sending}>
                Cancel
              </button>
            ) : (
              <button className="btn btn-primary" type="submit" disabled={blocked || !text.trim()}>
                {sending ? <Spinner /> : "Ask"}
              </button>
            )}
          </div>
          <p className="mt-1.5 px-0.5 text-[11px] text-muted">Enter to send · Shift+Enter for a new line</p>
        </form>
      ) : (
        <p className="border-t border-black/10 px-4 py-3 text-xs text-muted">You can read this chat. Someone who manages jobs confirms the cards.</p>
      )}
    </aside>
  );
}

function JobCard({
  change,
  messageId,
  clientId,
  canConfirm,
  onDone,
}: {
  change: JobChange;
  messageId: string;
  clientId?: string;
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
      await post(
        clientId ? `/jobs/chat/messages/${messageId}/confirm?clientId=${encodeURIComponent(clientId)}` : `/jobs/chat/messages/${messageId}/confirm`,
        {},
      );
      onDone();
    } catch (err) {
      setError(reason(err, "Could not save that job."));
    } finally {
      setBusy(false);
    }
  }

  const title = change.kind === "create_job" ? `Open ${change.jobReference}` : `Assign to ${change.jobReference}`;

  return (
    <div className="space-y-2 rounded-xl border border-moss/30 bg-white px-3 py-2.5 text-sm">
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
      {change.notSaved?.length ? (
        <div className="rounded-lg bg-clay/10 px-2.5 py-2 text-xs">
          <p className="font-medium text-clay">Not saved on this job</p>
          <ul className="mt-1 list-disc pl-4">
            {change.notSaved.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
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
