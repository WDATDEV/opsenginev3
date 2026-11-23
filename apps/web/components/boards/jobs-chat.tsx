"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Notice, Spinner } from "@/components/ui";
import { ApiError, BILL_BASES, api, billBasisLabel, canManageJobs, post, when } from "@/lib/api";

type CardPerson = { employeeId: string; name: string };
type FloorPerson = { id: string; name: string; clientId: string | null };

type CardTask = { title: string; activityCode: string; activityName: string; employeeId: string | null; name: string | null };

type JobChange = {
  kind: "create_job" | "assign_people" | "edit_job" | "add_tasks";
  clientId: string;
  clientName: string;
  jobReference: string;
  title: string;
  billBasis: string | null;
  people: CardPerson[];
  summary: string;
  notSaved?: string[];
  removePeople?: CardPerson[];
  crewBefore?: CardPerson[];
  before?: { reference: string; title: string; billBasis: string };
  tasks?: CardTask[];
  workOptions?: { code: string; name: string }[];
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

type Session = { id: string; title: string; updatedAt: string; hidden: boolean; messages: number; waiting: number; working: boolean };

type Detail = { thread: { id: string; title: string; hidden: boolean }; sessions: Session[]; messages: ChatMessage[] };

const STARTERS = [
  ["Open a job", "Open a job to "],
  ["Add a task", "Add a task to job "],
  ["Change a job", "Change job "],
  ["Assign people", "Assign "],
] as const;

// Claude sometimes marks words with **. Show them as bold instead of printing the stars.
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
      )}
    </>
  );
}

function reason(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function clock(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function JobsChat({ clientId, people, onChanged }: { clientId?: string; people: FloorPerson[]; onChanged: () => void }) {
  const user = useSession();
  const manage = canManageJobs(user?.role);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const threadRef = useRef<string | null>(null);
  const textRef = useRef("");
  const drafts = useRef(new Map<string, string>());
  const latest = useRef(0);
  textRef.current = text;
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";

  // Each chat keeps its own unsent text, so a half-typed job never lands in the wrong chat.
  const apply = useCallback((next: Detail) => {
    const previous = threadRef.current;
    if (previous && previous !== next.thread.id) {
      drafts.current.set(previous, textRef.current);
      setText(drafts.current.get(next.thread.id) ?? "");
    }
    threadRef.current = next.thread.id;
    setDetail(next);
  }, []);

  const load = useCallback(
    async (threadId?: string) => {
      const target = threadId ?? threadRef.current;
      const request = ++latest.current;
      const params = new URLSearchParams();
      if (clientId) params.set("clientId", clientId);
      if (target) params.set("threadId", target);
      const suffix = params.toString();
      try {
        const next = await api<Detail>(suffix ? `/jobs/chat?${suffix}` : "/jobs/chat");
        // Only the newest request may paint, so a slow answer cannot pull someone back to the old chat.
        if (request !== latest.current) return;
        apply(next);
        setError(null);
      } catch (err) {
        if (request === latest.current) setError(reason(err, "Could not open jobs chat."));
      }
    },
    [apply, clientId],
  );

  useEffect(() => {
    threadRef.current = null;
    drafts.current.clear();
    setText("");
    void load();
    void api<{ claude: boolean }>("/jobs/chat/ready")
      .then((row) => setReady(row.claude))
      .catch(() => setReady(false));
  }, [load]);

  const sessions = detail?.sessions ?? [];
  const hidden = Boolean(detail?.thread.hidden);
  const workingId = detail?.messages.find((message) => message.status === "working")?.id ?? null;
  const working = Boolean(workingId);
  const anyWorking = working || sessions.some((session) => session.working);
  const waitingElsewhere = sessions
    .filter((session) => !session.hidden && session.id !== detail?.thread.id)
    .reduce((sum, session) => sum + session.waiting, 0);
  const onEmptyChat = detail ? detail.messages.length === 0 && !hidden : false;

  useEffect(() => {
    if (!anyWorking) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [anyWorking, load]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.thread.id, detail?.messages.length, working]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 120)}px`;
  }, [text]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    if (!listOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setListOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen]);

  async function cancelFetch() {
    if (!workingId || sending) return;
    setSending(true);
    setError(null);
    try {
      latest.current += 1;
      apply(await post<Detail>(`/jobs/chat/messages/${workingId}/cancel${query}`, {}));
    } catch (err) {
      setError(reason(err, "Could not stop that."));
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    const asked = text.trim();
    if (!asked || sending || working || hidden || !manage) return;
    setSending(true);
    setError(null);
    try {
      latest.current += 1;
      const next = await post<Detail>("/jobs/chat", { text: asked, clientId: clientId ?? null, threadId: threadRef.current });
      apply(next);
      drafts.current.delete(next.thread.id);
      setText("");
    } catch (err) {
      setError(reason(err, "Could not send that."));
    } finally {
      setSending(false);
    }
  }

  async function startNew() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      latest.current += 1;
      apply(await post<Detail>(`/jobs/chat/threads${query}`, {}));
      setListOpen(false);
      setUndo(null);
      requestAnimationFrame(() => box.current?.focus());
    } catch (err) {
      setError(reason(err, "Could not open a new chat."));
    } finally {
      setSending(false);
    }
  }

  function openSession(id: string) {
    setListOpen(false);
    setError(null);
    if (id !== detail?.thread.id) void load(id);
  }

  async function hide(session: Session) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      latest.current += 1;
      const next = await post<Detail>(`/jobs/chat/threads/${session.id}/hide${query}`, {});
      if (session.id === threadRef.current) apply(next);
      else await load();
      setUndo({ id: session.id, title: session.title });
    } catch (err) {
      setError(reason(err, "Could not hide that chat."));
    } finally {
      setSending(false);
    }
  }

  async function show(id: string) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      latest.current += 1;
      apply(await post<Detail>(`/jobs/chat/threads/${id}/show${query}`, {}));
      setUndo(null);
      setListOpen(false);
    } catch (err) {
      setError(reason(err, "Could not show that chat."));
    } finally {
      setSending(false);
    }
  }

  const blocked = sending || working || hidden || ready === false;

  return (
    <aside className="card flex h-[38rem] flex-col overflow-hidden xl:h-[calc(100dvh-3rem)]" aria-label="Jobs chat">
      <div className="flex items-center gap-2 border-b border-black/10 px-3 py-2.5">
        <button
          ref={trigger}
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40"
          aria-expanded={listOpen}
          aria-controls="jobs-chat-sessions"
          onClick={() => setListOpen(!listOpen)}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium uppercase tracking-[0.1em] text-muted">Jobs chat</span>
            <span className="block truncate text-sm font-semibold">{detail?.thread.title ?? "Loading…"}</span>
          </span>
          {waitingElsewhere > 0 ? (
            <span className="shrink-0 rounded-full bg-clay/10 px-2 py-0.5 text-[11px] font-medium text-clay">{waitingElsewhere} waiting</span>
          ) : null}
          <svg className={`h-4 w-4 shrink-0 text-muted transition-transform ${listOpen ? "rotate-180" : ""}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="sr-only">{listOpen ? "Close chat list" : "Open chat list"}</span>
        </button>
        {manage ? (
          <button className="btn btn-sm shrink-0" type="button" disabled={sending || onEmptyChat} title={onEmptyChat ? "This chat is already new" : undefined} onClick={() => void startNew()}>
            New chat
          </button>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {listOpen ? (
          <SessionList
            sessions={sessions}
            currentId={detail?.thread.id ?? null}
            canManage={manage}
            busy={sending}
            onOpen={openSession}
            onHide={(session) => void hide(session)}
            onShow={(id) => void show(id)}
          />
        ) : null}
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
        {undo ? (
          <div className="mx-3 mt-3 flex items-center justify-between gap-2 rounded-lg bg-ink px-3 py-2 text-xs text-paper" role="status">
            <span className="min-w-0 truncate">Chat hidden</span>
            <button type="button" className="min-h-8 shrink-0 rounded px-2 font-semibold underline underline-offset-2" onClick={() => void show(undo.id)}>
              Undo
            </button>
          </div>
        ) : null}
        <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {detail && detail.messages.length === 0 ? (
            <div className="flex h-full flex-col justify-center gap-3 text-center">
              <div>
                <p className="font-semibold">What needs doing?</p>
                <p className="mx-auto mt-1 max-w-[17rem] text-sm leading-5 text-muted">
                  Open a job with its tasks, change one, or assign people{clientId ? " for this client" : ""}. Nothing saves until you press Confirm.
                </p>
              </div>
              {manage ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {STARTERS.map(([label, start]) => (
                    <button
                      key={label}
                      type="button"
                      className="min-h-10 rounded-full border border-black/15 bg-white px-3.5 text-sm font-medium transition-colors hover:border-moss"
                      onClick={() => {
                        setText(start);
                        requestAnimationFrame(() => {
                          box.current?.focus();
                          box.current?.setSelectionRange(start.length, start.length);
                        });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {detail?.messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex flex-col items-end gap-1">
                <p className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-moss px-3 py-2 text-sm leading-6 text-paper">{message.content}</p>
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
                ) : message.content ? (
                  <p className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-black/[0.04] px-3 py-2 text-sm leading-6">
                    <Rich text={message.content} />
                  </p>
                ) : null}
                {message.error ? <p className="text-xs text-clay">{message.error}</p> : null}
                {message.jobChange ? (
                  <JobCard
                    change={message.jobChange}
                    messageId={message.id}
                    clientId={clientId}
                    people={people}
                    canConfirm={manage && !hidden}
                    onEdited={apply}
                    onDone={() => void load().then(onChanged)}
                  />
                ) : null}
              </div>
            ),
          )}
        </div>
        {hidden ? (
          <div className="flex items-center justify-between gap-2 border-t border-black/10 px-4 py-3">
            <p className="text-sm text-muted">This chat is hidden.</p>
            {manage ? (
              <button className="btn btn-sm" type="button" disabled={sending} onClick={() => void show(detail!.thread.id)}>
                Show chat
              </button>
            ) : null}
          </div>
        ) : manage ? (
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
                placeholder="Open or change a job"
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
            <p className="mt-1.5 hidden px-0.5 text-[11px] text-muted sm:block">Enter to send · Shift+Enter for a new line</p>
          </form>
        ) : (
          <p className="border-t border-black/10 px-4 py-3 text-xs text-muted">You can read this chat. Someone who manages jobs confirms the cards.</p>
        )}
      </div>
    </aside>
  );
}

function SessionList({
  sessions,
  currentId,
  canManage,
  busy,
  onOpen,
  onHide,
  onShow,
}: {
  sessions: Session[];
  currentId: string | null;
  canManage: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onHide: (session: Session) => void;
  onShow: (id: string) => void;
}) {
  const [view, setView] = useState<"chats" | "hidden">("chats");
  const visible = sessions.filter((session) => !session.hidden);
  const hiddenChats = sessions.filter((session) => session.hidden);
  const shown = view === "chats" ? visible : hiddenChats;

  return (
    <div id="jobs-chat-sessions" className="absolute inset-0 z-10 flex flex-col bg-surface">
      <div className="flex gap-1 border-b border-black/10 px-3 py-2" role="group" aria-label="Which chats to show">
        {(
          [
            ["chats", `Chats (${visible.length})`],
            ["hidden", `Hidden (${hiddenChats.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            className={`min-h-9 rounded-lg px-3 text-sm font-medium transition-colors ${view === key ? "bg-ink text-paper" : "text-muted hover:bg-black/[0.05]"}`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-black/5 overflow-y-auto">
        {shown.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted">{view === "hidden" ? "No hidden chats. Hidden chats stay saved here." : "No chats yet."}</li>
        ) : null}
        {shown.map((session) => {
          const current = session.id === currentId;
          return (
            <li key={session.id} className={`flex items-center gap-1 pr-2 ${current ? "bg-moss/[0.07]" : ""}`}>
              <button
                type="button"
                className="min-h-14 min-w-0 flex-1 px-4 py-2 text-left transition-colors hover:bg-black/[0.03]"
                aria-current={current ? "true" : undefined}
                onClick={() => onOpen(session.id)}
              >
                <span className="block truncate text-sm font-medium">{session.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span>{session.messages === 0 ? "Empty" : when(session.updatedAt)}</span>
                  {session.working ? <span className="font-medium text-moss">Working…</span> : null}
                  {session.waiting > 0 ? <span className="font-medium text-clay">{session.waiting} to confirm</span> : null}
                </span>
              </button>
              {canManage && session.hidden ? (
                <button className="btn btn-ghost btn-sm shrink-0" type="button" disabled={busy} aria-label={`Show ${session.title}`} onClick={() => onShow(session.id)}>
                  Show
                </button>
              ) : null}
              {canManage && !session.hidden && session.messages > 0 ? (
                <button
                  className="btn btn-ghost btn-sm shrink-0"
                  type="button"
                  disabled={busy || session.working}
                  aria-label={`Hide ${session.title}`}
                  onClick={() => onHide(session)}
                >
                  Hide
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function JobCard({
  change,
  messageId,
  clientId,
  people,
  canConfirm,
  onEdited,
  onDone,
}: {
  change: JobChange;
  messageId: string;
  clientId?: string;
  people: FloorPerson[];
  canConfirm: boolean;
  onEdited: (next: Detail) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = change.status === "proposed" && new Date(change.expiresAt).getTime() < Date.now();
  const edited = change.kind === "edit_job" ? change.before : null;

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

  async function saveEdit(body: CardEditBody) {
    setBusy(true);
    setError(null);
    try {
      const next = await post<Detail>(
        clientId ? `/jobs/chat/messages/${messageId}/edit?clientId=${encodeURIComponent(clientId)}` : `/jobs/chat/messages/${messageId}/edit`,
        body,
      );
      onEdited(next);
      setEditing(false);
    } catch (err) {
      setError(reason(err, "Could not change that card."));
    } finally {
      setBusy(false);
    }
  }

  const title =
    change.kind === "create_job"
      ? `Open ${change.jobReference}`
      : change.kind === "edit_job"
        ? `Change ${change.before?.reference ?? change.jobReference}`
        : change.kind === "add_tasks"
          ? `Add tasks to ${change.jobReference}`
          : `Assign to ${change.jobReference}`;

  if (editing) {
    return (
      <CardEditor
        change={change}
        heading={title}
        people={people}
        busy={busy}
        error={error}
        onCancel={() => {
          setEditing(false);
          setError(null);
        }}
        onSave={(body) => void saveEdit(body)}
      />
    );
  }

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
            <dd>{billBasisLabel(change.billBasis ?? "mixed")}</dd>
          </>
        ) : null}
        {edited ? (
          <>
            {change.jobReference !== edited.reference ? <ChangedRow label="Reference" from={edited.reference} to={change.jobReference} /> : null}
            {change.title !== edited.title ? <ChangedRow label="Title" from={edited.title} to={change.title} /> : null}
            {(change.billBasis ?? edited.billBasis) !== edited.billBasis ? (
              <ChangedRow label="Bill by" from={billBasisLabel(edited.billBasis)} to={billBasisLabel(change.billBasis ?? edited.billBasis)} />
            ) : null}
            {change.people.length ? (
              <>
                <dt className="text-muted">Add</dt>
                <dd>{change.people.map((person) => person.name).join(", ")}</dd>
              </>
            ) : null}
            {change.removePeople?.length ? (
              <>
                <dt className="text-muted">Remove</dt>
                <dd>{change.removePeople.map((person) => person.name).join(", ")}</dd>
              </>
            ) : null}
          </>
        ) : change.tasks ? null : (
          <>
            <dt className="text-muted">People</dt>
            <dd>{change.people.length ? change.people.map((person) => person.name).join(", ") : "Nobody yet"}</dd>
          </>
        )}
      </dl>
      {change.tasks?.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{change.tasks.length === 1 ? "Task" : `${change.tasks.length} tasks`}</p>
          <ul className="divide-y divide-black/5 rounded-lg border border-black/10">
            {change.tasks.map((task, index) => (
              <li key={`${task.title}-${task.employeeId ?? "open"}-${index}`} className="px-2.5 py-2">
                <p className="break-words text-sm font-medium">{task.title}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {task.activityName} · {task.name ?? <span className="font-medium text-clay">Nobody assigned</span>}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {edited && change.status === "proposed" && (change.billBasis ?? edited.billBasis) !== edited.billBasis ? (
        <p className="text-xs text-muted">Charges already made stay as they are.</p>
      ) : null}
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
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner /> : "Confirm"}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChangedRow({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">
        <span className="text-muted line-through">{from}</span> <span className="font-medium">{to}</span>
      </dd>
    </>
  );
}

type EditedTask = { title: string; activityCode: string; employeeId: string | null };
type CardEditBody = { title?: string; reference?: string; billBasis?: string; employeeIds?: string[]; tasks?: EditedTask[] };

function CardEditor({
  change,
  heading,
  people,
  busy,
  error,
  onCancel,
  onSave,
}: {
  change: JobChange;
  heading: string;
  people: FloorPerson[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (body: CardEditBody) => void;
}) {
  const hasDetails = change.kind !== "assign_people" && change.kind !== "add_tasks";
  const hasTasks = Boolean(change.tasks);
  const workOptions = change.workOptions ?? [];
  const [taskRows, setTaskRows] = useState<EditedTask[]>(
    (change.tasks ?? []).map((task) => ({ title: task.title, activityCode: task.activityCode, employeeId: task.employeeId })),
  );
  const setTask = (index: number, patch: Partial<EditedTask>) =>
    setTaskRows((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const startCrew =
    change.kind === "edit_job"
      ? [
          ...(change.crewBefore ?? [])
            .filter((person) => !change.removePeople?.some((row) => row.employeeId === person.employeeId))
            .map((person) => person.employeeId),
          ...change.people.map((person) => person.employeeId),
        ]
      : change.people.map((person) => person.employeeId);
  const [title, setTitle] = useState(change.title);
  const [reference, setReference] = useState(change.jobReference);
  const [billBasis, setBillBasis] = useState(change.billBasis ?? "mixed");
  const [crew, setCrew] = useState<string[]>(startCrew);
  const eligible = people.filter((person) => !person.clientId || person.clientId === change.clientId);
  // Someone already on the job stays listed even if they could no longer be added.
  const listed = [
    ...eligible.map((person) => ({ id: person.id, name: person.name })),
    ...(change.crewBefore ?? [])
      .filter((person) => !eligible.some((row) => row.id === person.employeeId))
      .map((person) => ({ id: person.employeeId, name: person.name })),
  ];
  const missing = hasDetails && (!title.trim() || !reference.trim());
  const noCrew = change.kind === "assign_people" && crew.length === 0;
  const badTasks = hasTasks && (taskRows.length === 0 || taskRows.some((row) => !row.title.trim() || !row.activityCode));

  return (
    <form
      className="space-y-2.5 rounded-xl border border-moss/30 bg-white px-3 py-2.5 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (missing || noCrew || badTasks) return;
        const details = hasDetails ? { title: title.trim(), reference: reference.trim(), billBasis } : {};
        onSave(
          hasTasks
            ? { ...details, tasks: taskRows.map((row) => ({ ...row, title: row.title.trim() })) }
            : { ...details, employeeIds: crew },
        );
      }}
    >
      <p className="font-medium">Edit: {heading}</p>
      {hasDetails ? (
        <>
          <label className="block text-xs font-medium text-ink/80">
            Title
            <input className="field mt-1" maxLength={120} required value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="block text-xs font-medium text-ink/80">
            Reference
            <input className="field mt-1 font-mono" maxLength={40} required value={reference} onChange={(event) => setReference(event.target.value)} />
          </label>
          <label className="block text-xs font-medium text-ink/80">
            Bill by
            <select className="field mt-1" value={billBasis} onChange={(event) => setBillBasis(event.target.value)}>
              {BILL_BASES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {hasTasks ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-ink/80">Tasks</legend>
          {taskRows.map((row, index) => (
            <div key={index} className="space-y-1.5 rounded-lg border border-black/10 p-2">
              <input
                className="field"
                aria-label={`Task ${index + 1} title`}
                maxLength={120}
                required
                value={row.title}
                onChange={(event) => setTask(index, { title: event.target.value })}
              />
              <select
                className="field"
                aria-label={`Task ${index + 1} kind of work`}
                value={row.activityCode}
                onChange={(event) => setTask(index, { activityCode: event.target.value })}
              >
                {workOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name}
                  </option>
                ))}
              </select>
              <select
                className="field"
                aria-label={`Task ${index + 1} person`}
                value={row.employeeId ?? ""}
                onChange={(event) => setTask(index, { employeeId: event.target.value || null })}
              >
                <option value="">Nobody yet</option>
                {eligible.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
              {taskRows.length > 1 ? (
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  aria-label={`Remove task ${index + 1}`}
                  onClick={() => setTaskRows((rows) => rows.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <button
            className="btn btn-ghost btn-sm w-full"
            type="button"
            disabled={workOptions.length === 0 || taskRows.length >= 40}
            onClick={() => setTaskRows((rows) => [...rows, { title: "", activityCode: rows.at(-1)?.activityCode ?? workOptions[0]?.code ?? "", employeeId: null }])}
          >
            Add another task
          </button>
        </fieldset>
      ) : (
      <fieldset>
        <legend className="text-xs font-medium text-ink/80">People on this job</legend>
        {listed.length === 0 ? (
          <p className="mt-1 text-xs text-muted">Nobody can be assigned to this client yet.</p>
        ) : (
          <div className="mt-1 max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-black/10 p-1">
            {listed.map((person) => (
              <label key={person.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-black/[0.03]">
                <input
                  type="checkbox"
                  checked={crew.includes(person.id)}
                  onChange={(event) =>
                    setCrew(event.target.checked ? [...crew, person.id] : crew.filter((id) => id !== person.id))
                  }
                />
                <span className="truncate">{person.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      )}
      {noCrew ? <p className="text-xs text-clay">Choose at least one person.</p> : null}
      {error ? <p className="text-xs text-clay">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || missing || noCrew || badTasks}>
          {busy ? <Spinner /> : "Save changes"}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="text-[11px] text-muted">This updates the card. Press Confirm afterward to save it to the job.</p>
    </form>
  );
}
