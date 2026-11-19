"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, Field, Notice, SkeletonList, Spinner, timeAgo, useResource } from "@/components/ui";
import { api, ApiError, hasSection, post } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type Model = "haiku" | "sonnet";
type Thread = {
  id: string;
  title: string;
  warehanceClientId: number | null;
  warehanceClientName: string | null;
  model: Model;
  updatedAt: string;
};
type Proposal = { kind: "email" | "slack"; to: string; subject: string; body: string; fileId: string | null; fileName: string | null };
type StockRow = { sku: string; location: string; warehouse: string; qtyBefore: number; qtyAfter: number; lotCode: string; ok: boolean | null; error: string | null };
type StockChange = {
  logId: string | null;
  clientName: string;
  warehouse: string;
  action: "set";
  quantity: number;
  reason: string;
  rows: StockRow[];
  status: "proposed" | "applying" | "applied" | "rejected";
  expiresAt: string;
  note: string | null;
};
type PreparedChange = {
  kind: string;
  args: Record<string, unknown>;
  summary: string;
  before: Record<string, unknown>;
  status: "proposed" | "applying" | "applied" | "rejected";
  expiresAt: string;
  result: Record<string, unknown> | null;
  error: string | null;
};
type Send = { kind: "email" | "slack"; to: string; at: string; ok: boolean; note: string; file: string | null };
type BotLog = { tool: string; ok: boolean; records: number; error: string | null };
type WarehanceLink = { href: string; label: string; kind: string };
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "working" | "done" | "failed";
  error: string | null;
  lookups: { tool: string; summary: string }[];
  botLogs: BotLog[];
  links: WarehanceLink[];
  proposal: Proposal | null;
  stockChange: StockChange | null;
  change: PreparedChange | null;
  sends: Send[];
  createdAt: string;
};
type FileInfo = { id: string; messageId: string; name: string; format: string; rows: number; columns: string[]; size: number };
type Detail = { thread: Thread; messages: Message[]; files: FileInfo[] };
type Config = { warehance: boolean; warehanceWrite: boolean; claude: boolean; gmail: string | null; slack: boolean };
type Clients = { connected: boolean; clients: { id: number; name: string }[]; error?: string };
type Panel = { messageId: string; kind: "email" | "slack"; prefill: Proposal | null };

const EXAMPLES = [
  "How many orders shipped last week?",
  "List all orders that are on hold",
  "Make an Excel file of this month's shipments",
  "Which products are low on stock?",
  "List SKUs with quantity greater than 0 as a CSV",
  "Change stock for AI Testing Client",
];

function size(bytes: number) {
  return bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function stamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function clock(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function dayKey(value: string) {
  return new Date(value).toDateString();
}

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function Typing({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted">
      <span className="chat-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  );
}

function reason(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function WarehanceLinkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4h5v5" />
      <path d="M16 4 9 11" />
      <path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12" />
    </svg>
  );
}

export default function ChatPage() {
  const user = useSession();
  const allowed = hasSection(user, "chat");
  const config = useResource<Config>(allowed ? "/mail/chat/config" : null);
  const clients = useResource<Clients>(allowed ? "/mail/chat/clients" : null);
  const threads = useResource<Thread[]>(allowed ? "/mail/chat/threads" : null);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [showList, setShowList] = useState(false);
  const [query, setQuery] = useState("");
  // The settings for a chat that has not started yet.
  const [scope, setScope] = useState<{ id: number | null; name: string | null }>({ id: null, name: null });
  const [model, setModel] = useState<Model>("haiku");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);

  const current = useRef<string | null>(null);
  current.current = selected;
  const bottom = useRef<HTMLDivElement | null>(null);

  const reloadThreads = threads.reload;

  const load = useCallback(async (id: string) => {
    try {
      const next = await api<Detail>(`/mail/chat/threads/${id}`);
      if (current.current === id) {
        setDetail(next);
        setLoadError(null);
      }
    } catch (err) {
      if (current.current === id) setLoadError(reason(err, "Could not open this chat."));
    }
  }, []);

  function open(id: string | null) {
    setSelected(id);
    setDetail(null);
    setLoadError(null);
    setError(null);
    setPanel(null);
    setRenaming(null);
    setShowList(false);
    if (id) void load(id);
  }

  const working = Boolean(detail?.messages.some((message) => message.status === "working"));
  useEffect(() => {
    if (!selected || !working) return;
    const timer = setInterval(() => void load(selected), 2000);
    return () => clearInterval(timer);
  }, [selected, working, load]);

  // When an answer arrives, the list moves that chat to the top.
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) reloadThreads();
    wasWorking.current = working;
  }, [working, reloadThreads]);

  const count = detail?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count, working]);

  const ready = Boolean(config.data?.warehance && config.data?.claude);

  async function submit(question: string) {
    const asked = question.trim();
    if (!asked || sending || working) return;
    setSending(true);
    setError(null);
    try {
      let id = selected;
      if (!id) {
        const made = await post<Thread>("/mail/chat/threads", { clientId: scope.id, clientName: scope.name, model });
        id = made.id;
        current.current = id;
        setSelected(id);
      }
      const next = await post<Detail>(`/mail/chat/threads/${id}/messages`, { text: asked });
      setDetail(next);
      setText("");
      reloadThreads();
    } catch (err) {
      setError(reason(err, "Could not send that."));
    } finally {
      setSending(false);
    }
  }

  async function change(patch: { title?: string; clientId?: number | null; clientName?: string | null; model?: Model }) {
    if (!selected) return;
    try {
      await api(`/mail/chat/threads/${selected}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load(selected);
      reloadThreads();
    } catch (err) {
      setError(reason(err, "Could not save that change."));
    }
  }

  async function remove(thread: Thread) {
    if (!window.confirm(`Delete "${thread.title}"? Its files go with it.`)) return;
    try {
      await api(`/mail/chat/threads/${thread.id}`, { method: "DELETE" });
      if (selected === thread.id) open(null);
      reloadThreads();
    } catch (err) {
      setError(reason(err, "Could not delete that chat."));
    }
  }

  const pickClient = useMemo(
    () => (value: string) => {
      if (!value) return { id: null, name: null };
      const found = clients.data?.clients.find((item) => String(item.id) === value);
      return { id: found?.id ?? Number(value), name: found?.name ?? null };
    },
    [clients.data],
  );

  if (!user) return <SkeletonList rows={3} />;
  if (!allowed) return <Notice tone="bad">Chat is not turned on for this account.</Notice>;

  const thread = detail?.thread ?? null;
  const activeScope = thread ? { id: thread.warehanceClientId, name: thread.warehanceClientName } : scope;
  const activeModel = thread?.model ?? model;
  const setupGaps = config.data
    ? [
        !config.data.warehance ? "the Warehance bot" : null,
        !config.data.claude ? "the Claude API key" : null,
      ].filter(Boolean)
    : [];
  const listed = (threads.data ?? []).filter((item) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${item.title} ${item.warehanceClientName ?? "all clients"}`.toLowerCase().includes(needle);
  });

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[28rem] flex-col md:h-[calc(100dvh-6.75rem)]">
      <header className="mb-3 flex flex-none flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Chat</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight">Warehance</h1>
        </div>
        {setupGaps.length > 0 ? <Notice tone="warn">Add {setupGaps.join(" and ")} in Settings before chatting.</Notice> : null}
      </header>
      {clients.data && clients.data.connected && clients.data.error ? (
        <div className="mb-3 flex-none">
          <Notice tone="warn">The client list could not be loaded ({clients.data.error}). You can still chat about all clients.</Notice>
        </div>
      ) : null}

      <div className="relative grid min-h-0 flex-1 gap-3 md:grid-cols-[248px_1fr]">
        <aside
          className={`${showList ? "absolute inset-0 z-20 flex flex-col rounded-2xl border border-black/10 bg-surface p-3 shadow-md md:static md:z-auto md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none" : "hidden md:flex md:flex-col"}`}
        >
          <button className="btn btn-primary w-full" type="button" onClick={() => open(null)}>
            New chat
          </button>
          <input
            className="field mt-2 h-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
            {threads.loading && !threads.data ? <SkeletonList rows={4} /> : null}
            {threads.error ? <Notice tone="bad">{threads.error}</Notice> : null}
            {threads.data && threads.data.length === 0 ? <p className="px-1 py-2 text-sm text-muted">No chats yet.</p> : null}
            {threads.data && threads.data.length > 0 && listed.length === 0 ? <p className="px-1 py-2 text-sm text-muted">No chats match that search.</p> : null}
            <ul className="space-y-0.5">
              {listed.map((item) => (
                <li key={item.id}>
                  <div
                    className={`group flex items-start gap-1 rounded-xl px-2.5 py-2 text-sm transition-colors ${
                      item.id === selected ? "bg-moss/10 text-moss" : "hover:bg-black/5"
                    }`}
                  >
                    <button className="min-w-0 flex-1 text-left" type="button" onClick={() => open(item.id)}>
                      <span className="block truncate font-medium text-ink">{item.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {item.warehanceClientName ?? "All clients"} · {timeAgo(item.updatedAt)}
                      </span>
                    </button>
                    <button
                      className="mt-0.5 flex-none rounded-md px-1.5 text-base leading-none text-muted opacity-0 hover:bg-black/5 hover:text-rust group-hover:opacity-100 focus:opacity-100"
                      type="button"
                      aria-label={`Delete ${item.title}`}
                      title="Delete"
                      onClick={() => void remove(item)}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="flex flex-none flex-wrap items-center gap-2 border-b border-black/10 px-3 py-2.5 sm:px-4">
            <button className="btn btn-sm btn-ghost md:hidden" type="button" onClick={() => setShowList((value) => !value)}>
              {showList ? "Close" : "Chats"}
            </button>
            {thread ? (
              renaming !== null ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (renaming.trim()) void change({ title: renaming.trim() });
                    setRenaming(null);
                  }}
                >
                  <input className="field h-9 min-w-0 flex-1" value={renaming} onChange={(event) => setRenaming(event.target.value)} maxLength={120} autoFocus aria-label="Chat name" />
                  <button className="btn btn-sm" type="submit">Save</button>
                </form>
              ) : (
                <button className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline" type="button" onClick={() => setRenaming(thread.title)} title="Rename">
                  {thread.title}
                </button>
              )
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">New chat</span>
            )}
            <label className="flex items-center gap-1.5 text-sm">
              <span className="sr-only sm:not-sr-only text-muted">Client</span>
              <select
                className="field h-9 w-36 sm:w-44"
                value={activeScope.id ? String(activeScope.id) : ""}
                disabled={!clients.data?.connected}
                aria-label="Client"
                onChange={(event) => {
                  const next = pickClient(event.target.value);
                  if (thread) void change({ clientId: next.id, clientName: next.name });
                  else setScope(next);
                }}
              >
                <option value="">All clients</option>
                {(clients.data?.clients ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <span className="sr-only sm:not-sr-only text-muted">Model</span>
              <select
                className="field h-9 w-24 sm:w-28"
                value={activeModel}
                aria-label="Model"
                onChange={(event) => {
                  const next = event.target.value as Model;
                  if (thread) void change({ model: next });
                  else setModel(next);
                }}
              >
                <option value="haiku">Fast</option>
                <option value="sonnet">Careful</option>
              </select>
            </label>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-5" aria-live="polite">
            {selected && !detail && !loadError ? <SkeletonList rows={3} /> : null}
            {loadError ? <Notice tone="bad">{loadError}</Notice> : null}
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center px-2 py-8 text-center">
                <p className="text-lg font-semibold">Ask about warehouse data</p>
                <p className="mt-1 max-w-md text-sm leading-6 text-muted">Orders, shipments, stock, clients. Ask for a file when you want the full list.</p>
                <div className="mt-5 flex max-w-xl flex-wrap justify-center gap-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm text-ink/80 transition-colors hover:border-moss/30 hover:bg-moss/5 hover:text-ink disabled:opacity-50"
                      type="button"
                      disabled={!ready}
                      onClick={() => setText(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {detail?.messages.map((message, index) => {
              const previous = detail.messages[index - 1];
              const showDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
              return (
                <Fragment key={message.id}>
                  {showDay ? (
                    <p className="pt-1 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{dayLabel(message.createdAt)}</p>
                  ) : null}
                  <Bubble
                    threadId={detail.thread.id}
                    message={message}
                    files={detail.files.filter((file) => file.messageId === message.id)}
                    isOwner={user?.role === "owner"}
                    canWrite={Boolean(config.data?.warehanceWrite)}
                    onSend={(kind, prefill) => setPanel({ messageId: message.id, kind, prefill })}
                    onFilesChanged={() => void load(detail.thread.id)}
                  />
                </Fragment>
              );
            })}
            {panel && detail ? (
              <SendPanel
                key={`${panel.messageId}-${panel.kind}`}
                threadId={detail.thread.id}
                panel={panel}
                files={detail.files}
                config={config.data}
                onClose={() => setPanel(null)}
                onDone={() => void load(detail.thread.id)}
              />
            ) : null}
            <div ref={bottom} />
          </div>

          {error ? (
            <div className="flex-none px-3 sm:px-4">
              <Notice tone="bad">{error}</Notice>
            </div>
          ) : null}

          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => void submit(text)}
            disabled={!ready || sending}
            busy={sending || working}
            placeholder={ready ? "Ask a question, or ask for a file…" : "Finish setup in Settings first"}
            hint={
              activeScope.id
                ? `Looking up ${activeScope.name ?? `client ${activeScope.id}`}. Enter to send, Shift+Enter for a new line.`
                : "All clients. Enter to send, Shift+Enter for a new line."
            }
          />
        </section>
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  busy,
  placeholder,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  hint?: string;
}) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 160)}px`;
  }, [value]);

  return (
    <form
      className="flex-none border-t border-black/10 px-3 py-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          ref={box}
          className="field min-h-[2.75rem] flex-1 resize-none overflow-hidden py-2.5"
          rows={1}
          value={value}
          maxLength={8000}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Your message"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={disabled || busy || !value.trim()}>
          {busy ? <Spinner /> : "Send"}
        </button>
      </div>
      {hint ? <p className="mt-1.5 px-0.5 text-[11px] leading-4 text-muted">{hint}</p> : null}
    </form>
  );
}

// ---------------------------------------------------------------- one message

function Bubble({
  threadId,
  message,
  files,
  isOwner,
  canWrite,
  onSend,
  onFilesChanged,
}: {
  threadId: string;
  message: Message;
  files: FileInfo[];
  isOwner: boolean;
  canWrite: boolean;
  onSend: (kind: "email" | "slack", prefill: Proposal | null) => void;
  onFilesChanged: () => void;
}) {
  const [showLookups, setShowLookups] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverNote, setRecoverNote] = useState<string | null>(null);
  const kept = (message.botLogs ?? []).reduce((sum, log) => sum + (log.ok ? log.records : 0), 0);

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="max-w-[min(85%,38rem)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-moss px-3.5 py-2.5 text-sm leading-6 text-paper">{message.content}</p>
        <span className="px-1 text-[11px] text-muted">{clock(message.createdAt)}</span>
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="max-w-[min(92%,42rem)] space-y-2">
        {message.status === "working" ? (
          <div className="rounded-2xl rounded-bl-md bg-black/[0.04] px-3.5 py-2.5 text-sm">
            <Typing label={message.lookups.length > 0 ? "Working on it…" : "Looking things up…"} />
            {message.lookups.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-xs text-muted">
                {message.lookups.slice(-4).map((item, index) => (
                  <li key={`${item.summary}-${index}`}>{item.summary}</li>
                ))}
              </ul>
            ) : null}
            {kept > 0 ? <p className="mt-2 text-xs text-muted">Keeping {kept} Warehance record(s) in case this fails.</p> : null}
          </div>
        ) : null}
        {message.status === "failed" ? (
          <Notice tone="bad">
            {message.error ?? "That did not work."}
            {kept > 0 ? ` The Warehance records from this turn were kept (${kept} row(s)), so you can recover them as a file.` : ""}
          </Notice>
        ) : null}
        {message.status === "done" ? (
          <div className="space-y-1">
            <p className="whitespace-pre-wrap rounded-2xl rounded-bl-md bg-black/[0.04] px-3.5 py-2.5 text-sm leading-6">{message.content}</p>
            <p className="px-1 text-[11px] text-muted">{clock(message.createdAt)}</p>
          </div>
        ) : null}

        {message.role === "assistant" && message.status === "done" && (message.links ?? []).length > 0 ? (
          <div className="rounded-xl border border-black/10 px-2 py-2">
            <p className="px-1 text-xs font-medium text-muted">Open in Warehance</p>
            <ul className="mt-1 grid sm:grid-cols-2">
              {message.links.map((link) => (
                <li key={link.href}>
                  <a
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-moss/10"
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="min-w-0 flex-1 truncate">{link.label}</span>
                    <span className="flex-none text-moss">
                      <WarehanceLinkIcon />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {message.stockChange ? (
          <StockCard threadId={threadId} messageId={message.id} change={message.stockChange} isOwner={isOwner} canWrite={canWrite} onDone={onFilesChanged} />
        ) : null}
        {message.change ? (
          <ChangeCard threadId={threadId} messageId={message.id} change={message.change} isOwner={isOwner} canWrite={canWrite} onDone={onFilesChanged} />
        ) : null}

        {files.map((file) => (
          <ChatFile key={file.id} file={file} onSaved={onFilesChanged} />
        ))}

        {message.status === "done" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {message.proposal ? (
              <button className="btn btn-sm btn-primary" type="button" onClick={() => onSend(message.proposal!.kind, message.proposal)}>
                Review {message.proposal.kind === "email" ? "email" : "Slack message"}
              </button>
            ) : null}
            {!(message.proposal?.kind === "email") ? (
              <button className="btn btn-sm btn-ghost" type="button" onClick={() => onSend("email", null)}>
                Email this
              </button>
            ) : null}
            {!(message.proposal?.kind === "slack") ? (
              <button className="btn btn-sm btn-ghost" type="button" onClick={() => onSend("slack", null)}>
                Send to Slack
              </button>
            ) : null}
            {message.lookups.length > 0 ? (
              <button className="text-xs text-muted hover:underline" type="button" onClick={() => setShowLookups((value) => !value)}>
                {showLookups ? "Hide" : "Show"} {message.lookups.length} lookup(s)
              </button>
            ) : null}
          </div>
        ) : null}

        {kept > 0 && message.status !== "working" ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-sm"
              type="button"
              disabled={recovering}
              onClick={() => {
                setRecovering(true);
                setRecoverNote(null);
                void post<{ files: FileInfo[]; rows: number }>(`/mail/chat/threads/${threadId}/messages/${message.id}/recover`, { format: "csv" })
                  .then((saved) => {
                    setRecoverNote(`Recovered ${saved.rows} row(s) into ${saved.files.map((file) => file.name).join(", ")}.`);
                    onFilesChanged();
                  })
                  .catch((err) => setRecoverNote(reason(err, "Could not recover those records.")))
                  .finally(() => setRecovering(false));
              }}
            >
              {recovering ? <Spinner /> : `Recover ${kept} record(s) as CSV`}
            </button>
            {recoverNote ? <span className="text-xs text-muted">{recoverNote}</span> : null}
          </div>
        ) : null}

        {showLookups ? (
          <ul className="space-y-0.5 rounded-xl border border-black/10 px-3 py-2 text-xs text-muted">
            {message.lookups.map((item, index) => (
              <li key={`${item.summary}-${index}`}>{item.summary}</li>
            ))}
          </ul>
        ) : null}

        {message.sends.map((send, index) => (
          <p key={`${send.at}-${index}`} className="text-xs text-muted">
            <Badge tone={send.ok ? "ok" : "bad"} dot>
              {send.ok ? "Sent" : "Not sent"}
            </Badge>{" "}
            {send.kind === "email" ? "Email" : "Slack"} to {send.to}
            {send.file ? ` with ${send.file}` : ""} · {stamp(send.at)}
            {send.note && send.note !== "Sent" ? ` · ${send.note}` : ""}
          </p>
        ))}
      </div>
    </div>
  );
}

function StockCard({
  threadId,
  messageId,
  change,
  isOwner,
  canWrite,
  onDone,
}: {
  threadId: string;
  messageId: string;
  change: StockChange;
  isOwner: boolean;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = change.status === "proposed" && new Date(change.expiresAt).getTime() < Date.now();
  const rows = change.rows.filter((row) => !dropped.has(`${row.sku}|${row.location}`));

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await post(`/mail/chat/threads/${threadId}/messages/${messageId}/stock`, {
        keep: rows.map((row) => ({ sku: row.sku, location: row.location })),
      });
      onDone();
    } catch (err) {
      setError(reason(err, "Could not apply that stock change."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-2 border-moss/30 p-3 text-sm">
      <p className="font-medium">Stock change · {change.clientName}</p>
      <p className="text-xs text-muted">
        {change.warehouse} · action {change.action} · qty {change.quantity} · {change.reason}
      </p>
      {change.note ? <p className="text-xs text-muted">{change.note}</p> : null}
      <ul className="space-y-1 text-xs">
        {change.rows.map((row) => {
          const key = `${row.sku}|${row.location}`;
          const out = dropped.has(key);
          return (
            <li key={key} className={out ? "text-muted line-through" : ""}>
              {row.sku} @ {row.location}: {row.qtyBefore} → {row.qtyAfter}
              {row.ok === true ? " · done" : null}
              {row.ok === false ? ` · ${row.error ?? "failed"}` : null}
              {change.status === "proposed" && isOwner ? (
                <button className="ml-2 underline" type="button" onClick={() => setDropped((set) => {
                  const next = new Set(set);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })}>
                  {out ? "Keep" : "Drop"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {change.status === "proposed" && !isOwner ? <p className="text-xs text-muted">Only the owner can confirm this. Warehance is unchanged.</p> : null}
      {change.status === "proposed" && isOwner && !canWrite ? (
        <Notice tone="warn">Add a Warehance write key in Settings. Confirm cannot change stock without it.</Notice>
      ) : null}
      {change.status === "applying" ? <Notice tone="warn">Applying… do not confirm again. Check the bin if this stays here.</Notice> : null}
      {change.status === "proposed" && isOwner && expired ? <Notice tone="warn">This card expired. Ask again.</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {change.status === "applied" ? <Notice tone="ok">{change.note ?? "Warehance was updated."}</Notice> : null}
      {change.status === "rejected" ? <Notice tone="bad">{change.note ?? "That change was not applied."}</Notice> : null}
      {change.status === "proposed" && isOwner && !expired ? (
        <button className="btn btn-primary btn-sm" type="button" disabled={busy || rows.length === 0} onClick={() => void confirm()}>
          {busy ? <Spinner /> : `Confirm ${rows.length} row(s)`}
        </button>
      ) : null}
    </div>
  );
}

function changeTitle(change: PreparedChange) {
  const args = change.args;
  if (change.kind === "cancel_order") return `Cancel order #${args.order_id ?? ""}`.trim();
  if (change.kind === "update_order") return `Update order #${args.order_id ?? ""}`.trim();
  if (change.kind === "cancel_order_item") return `Cancel order item #${args.order_item_id ?? ""}`.trim();
  if (change.kind === "update_order_item") return `Update order item #${args.order_item_id ?? ""}`.trim();
  if (change.kind === "update_product") return `Update product #${args.product_id ?? ""}`.trim();
  if (change.kind === "move_inventory") return `Move SKU ${args.sku ?? ""}`.trim();
  if (change.kind === "adjust_inventory") return `Adjust SKU ${args.sku ?? ""}`.trim();
  return change.kind;
}

function confirmLabel(change: PreparedChange) {
  if (change.kind === "cancel_order") return `Cancel order #${change.args.order_id ?? ""}`.trim();
  if (change.kind === "cancel_order_item") return `Cancel item #${change.args.order_item_id ?? ""}`.trim();
  return "Confirm";
}

function fieldRows(change: PreparedChange) {
  const skip = new Set(["client_id", "reason", "note"]);
  return Object.entries(change.args).filter(([key]) => !skip.has(key));
}

function ChangeCard({
  threadId,
  messageId,
  change,
  isOwner,
  canWrite,
  onDone,
}: {
  threadId: string;
  messageId: string;
  change: PreparedChange;
  isOwner: boolean;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = change.status === "proposed" && new Date(change.expiresAt).getTime() < Date.now();
  const cancel = change.kind === "cancel_order" || change.kind === "cancel_order_item";
  const bins = Array.isArray(change.before.bins) ? (change.before.bins as { location?: string; quantity?: number | null }[]) : [];

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await post(`/mail/chat/threads/${threadId}/messages/${messageId}/change`, {});
      onDone();
    } catch (err) {
      setError(reason(err, "Could not apply that change."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card space-y-2 p-3 text-sm ${cancel ? "border-red-300" : "border-moss/30"}`}>
      <p className="font-medium">{changeTitle(change)}</p>
      {change.summary ? <p className="text-xs text-muted">{change.summary}</p> : null}
      {cancel ? (
        <Notice tone="warn">
          This cancels {change.kind === "cancel_order" ? "the order" : "the item"}. It can&apos;t be undone from Ops Engine.
        </Notice>
      ) : null}
      <table className="w-full text-left text-xs">
        <thead className="text-muted">
          <tr>
            <th className="py-1 font-medium">Field</th>
            <th className="py-1 font-medium">Before</th>
            <th className="py-1 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {fieldRows(change).map(([key, value]) => (
            <tr key={key} className="border-t border-black/5">
              <td className="py-1 pr-2 font-mono">{key}</td>
              <td className="py-1 text-muted">{change.before[key] == null ? "—" : typeof change.before[key] === "object" ? JSON.stringify(change.before[key]) : String(change.before[key])}</td>
              <td className="py-1">{typeof value === "object" ? JSON.stringify(value) : String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {change.kind === "move_inventory" && bins.length > 0 ? (
        <ul className="text-xs text-muted">
          {bins.map((bin) => (
            <li key={String(bin.location)}>
              {bin.location}: {bin.quantity ?? "?"} on hand
            </li>
          ))}
        </ul>
      ) : null}
      {change.status === "proposed" && !isOwner ? <p className="text-xs text-muted">Only the owner can confirm this. Warehance is unchanged.</p> : null}
      {change.status === "proposed" && isOwner && !canWrite ? (
        <Notice tone="warn">Add a Warehance write key in Settings. Confirm cannot change Warehance without it.</Notice>
      ) : null}
      {change.status === "applying" ? <Notice tone="warn">Applying… do not confirm again.</Notice> : null}
      {change.status === "proposed" && isOwner && expired ? <Notice tone="warn">This card expired. Ask again.</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {change.status === "applied" ? <Notice tone="ok">Warehance was updated.</Notice> : null}
      {change.status === "rejected" ? <Notice tone="bad">{change.error ?? "That change was not applied."}</Notice> : null}
      {change.status === "proposed" && isOwner && !expired ? (
        <button className={`btn btn-sm ${cancel ? "btn-danger" : "btn-primary"}`} type="button" disabled={busy} onClick={() => void confirm()}>
          {busy ? <Spinner /> : confirmLabel(change)}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- spreadsheet on a chat file

type TableFile = { id: string; name: string; format: string; columns: string[]; cells: string[][] };

const QTY_NAMES = ["qty", "quantity", "on_hand", "onhand", "qty_on_hand", "quantity_on_hand", "available", "stock", "units", "qoh", "inventory"];

function qtyColumn(columns: string[]) {
  const names = columns.map((column) => column.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  for (const wanted of QTY_NAMES) {
    const index = names.findIndex((name) => name === wanted || name.endsWith(`_${wanted}`) || name.startsWith(`${wanted}_`));
    if (index >= 0) return index;
  }
  return names.findIndex((name) => name.includes("qty") || name.includes("quantity"));
}

function ChatFile({ file, onSaved }: { file: FileInfo; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card space-y-2 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{file.name}</span>
          <span className="block text-xs text-muted">
            {file.rows} row(s) · {file.columns.length} column(s) · {size(file.size)}
          </span>
        </span>
        <button className="btn btn-sm" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Edit"}
        </button>
        <a className="btn btn-sm" href={`${API_URL}/mail/chat/files/${file.id}/download`}>
          Download
        </a>
      </div>
      {open ? <FileEditor fileId={file.id} onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
    </div>
  );
}

type Check = { ok: boolean; text: string };

function FileEditor({ fileId, onClose, onSaved }: { fileId: string; onClose: () => void; onSaved: () => void }) {
  const [table, setTable] = useState<TableFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<"set" | "adjust">("set");
  const [warehouse, setWarehouse] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [zeroAll, setZeroAll] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [download, setDownload] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let live = true;
    api<TableFile>(`/mail/chat/files/${fileId}/table`)
      .then((next) => {
        if (!live) return;
        setTable(next);
        const guessed = qtyColumn(next.columns);
        setQty(guessed >= 0 ? guessed : 0);
      })
      .catch((err) => {
        if (live) setError(reason(err, "Could not open that file."));
      });
    return () => {
      live = false;
    };
  }, [fileId]);

  function setCell(row: number, col: number, value: string) {
    setTable((current) => {
      if (!current) return current;
      const cells = current.cells.map((line, index) => (index === row ? line.map((cell, i) => (i === col ? value : cell)) : line));
      return { ...current, cells };
    });
  }

  function zeroQty(all: boolean) {
    if (!table) return;
    setTable({
      ...table,
      cells: table.cells.map((line, index) => (all || picked.has(index) ? line.map((cell, i) => (i === qty ? "0" : cell)) : line)),
    });
    setNotice(all ? "All quantities set to 0. Save, then download and upload in Warehance." : "Selected quantities set to 0. Save, then download and upload in Warehance.");
  }

  function dropPicked() {
    if (!table || picked.size === 0) return;
    setTable({ ...table, cells: table.cells.filter((_, index) => !picked.has(index)) });
    setPicked(new Set());
  }

  async function save() {
    if (!table) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await post<FileInfo>(`/mail/chat/files/${fileId}/table`, {
        columns: table.columns,
        cells: table.cells,
        name: table.name,
      });
      setNotice(`Saved as ${saved.name}. Download that file and upload it in Warehance. Nothing was changed in Warehance from here.`);
      setDownload({ id: saved.id, name: saved.name });
      onSaved();
    } catch (err) {
      setError(reason(err, "Could not save that file."));
    } finally {
      setBusy(false);
    }
  }

  async function warehance() {
    if (!table) return;
    setBusy(true);
    setError(null);
    setChecks(null);
    try {
      const saved = await post<FileInfo & { checks: Check[]; ready: boolean }>(`/mail/chat/files/${fileId}/warehance`, {
        columns: table.columns,
        cells: table.cells,
        action,
        warehouse,
        reason: adjustmentReason,
        zeroQuantity: zeroAll,
      });
      setChecks(saved.checks);
      setDownload({ id: saved.id, name: saved.name });
      setNotice(
        saved.ready
          ? `Saved ${saved.name}. Check the list below, then download and import it in Warehance (Inventory → Import). Nothing was changed in Warehance from here.`
          : `Saved ${saved.name}, but it is not ready to upload. Fix the failed checks first so Warehance does not reject the file or change the wrong stock.`,
      );
      onSaved();
    } catch (err) {
      setError(reason(err, "Could not convert that file."));
    } finally {
      setBusy(false);
    }
  }

  if (error && !table) return <Notice tone="bad">{error}</Notice>;
  if (!table) return <Spinner label="Opening file…" />;

  const allPicked = table.cells.length > 0 && picked.size === table.cells.length;

  return (
    <div className="space-y-2 border-t border-black/10 pt-2">
      <p className="text-xs text-muted">Edits stay in Ops Engine until you download the file and upload it in Warehance. Warehance is not changed from Chat.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          Quantity column
          <select className="field h-8 w-40" value={qty} onChange={(event) => setQty(Number(event.target.value))}>
            {table.columns.map((column, index) => (
              <option key={`${column}-${index}`} value={index}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-sm" type="button" onClick={() => zeroQty(false)} disabled={picked.size === 0}>
          Set selected to 0
        </button>
        <button className="btn btn-sm" type="button" onClick={() => zeroQty(true)}>
          Set all quantities to 0
        </button>
        <button className="btn btn-sm btn-ghost" type="button" onClick={dropPicked} disabled={picked.size === 0}>
          Remove selected rows
        </button>
      </div>
      <div className="max-h-[24rem] overflow-auto rounded-lg border border-black/10">
        <table className="min-w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th className="px-2 py-1">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(table.cells.map((_, index) => index)))}
                  aria-label="Select all rows"
                />
              </th>
              {table.columns.map((column, index) => (
                <th key={`${column}-${index}`} className="whitespace-nowrap px-2 py-1 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.cells.map((line, row) => (
              <tr key={row} className="border-t border-black/5">
                <td className="px-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={picked.has(row)}
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(row)) next.delete(row);
                      else next.add(row);
                      setPicked(next);
                    }}
                    aria-label={`Select row ${row + 1}`}
                  />
                </td>
                {line.map((cell, col) => (
                  <td key={col} className="px-1 py-0.5">
                    <input className="field h-8 min-w-[5.5rem] text-xs" value={cell} onChange={(event) => setCell(row, col, event.target.value)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 rounded-lg border border-black/10 p-3">
        <p className="text-xs font-medium">Warehance inventory import</p>
        <p className="text-xs text-muted">
          Converts this table to the Warehance template: sku, action, quantity, location, adjustment_reason, warehouse. We map SKU, qty, and location from the chat file. Fill warehouse and reason if those columns are missing.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Action
            <select className="field mt-1 h-8 w-28" value={action} onChange={(event) => setAction(event.target.value as "set" | "adjust")}>
              <option value="set">set</option>
              <option value="adjust">adjust</option>
            </select>
          </label>
          <label className="text-xs">
            Warehouse name
            <input className="field mt-1 h-8 w-48" value={warehouse} onChange={(event) => setWarehouse(event.target.value)} placeholder="Must already exist" />
          </label>
          <label className="text-xs">
            Adjustment reason
            <input className="field mt-1 h-8 w-56" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} placeholder="Cycle count" />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={zeroAll} onChange={(event) => setZeroAll(event.target.checked)} />
            Set every quantity to 0 in the upload file
          </label>
        </div>
      </div>
      {checks ? (
        <ul className="space-y-1 text-xs">
          {checks.map((check) => (
            <li key={check.text} className={check.ok ? "text-muted" : "text-red-700"}>
              {check.ok ? "OK — " : "Fix — "}
              {check.text}
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? <Notice tone={checks?.some((check) => !check.ok) ? "warn" : "ok"}>{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="button" disabled={busy || table.cells.length === 0} onClick={() => void warehance()}>
          {busy ? <Spinner /> : "Make Warehance CSV"}
        </button>
        <button className="btn btn-sm" type="button" disabled={busy || table.cells.length === 0} onClick={() => void save()}>
          Save a copy
        </button>
        {download ? (
          <a className="btn btn-sm" href={`${API_URL}/mail/chat/files/${download.id}/download`}>
            Download {download.name}
          </a>
        ) : null}
        <button className="btn btn-sm btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- email and Slack

function SendPanel({
  threadId,
  panel,
  files,
  config,
  onClose,
  onDone,
}: {
  threadId: string;
  panel: Panel;
  files: FileInfo[];
  config: Config | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { kind, prefill } = panel;
  const own = files.filter((file) => file.messageId === panel.messageId).map((file) => file.id);
  const [to, setTo] = useState(prefill?.to ?? "");
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [body, setBody] = useState(prefill?.body ?? "");
  const [picked, setPicked] = useState<string[]>(prefill?.fileId ? [prefill.fileId] : own);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);

  const connected = kind === "email" ? Boolean(config?.gmail) : Boolean(config?.slack);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      if (kind === "email") {
        await post(`/mail/chat/threads/${threadId}/email`, { messageId: panel.messageId, to, subject, body, fileIds: picked });
        setResult({ tone: "ok", text: "Email sent." });
      } else {
        const sent = await post<{ note: string }>(`/mail/chat/threads/${threadId}/slack`, { messageId: panel.messageId, to, text: body, fileIds: picked });
        setResult({ tone: sent.note === "Sent" ? "ok" : "warn", text: sent.note === "Sent" ? "Sent to Slack." : sent.note });
      }
      onDone();
    } catch (err) {
      setResult({ tone: "bad", text: reason(err, "Could not send that.") });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const sent = result?.tone === "ok";

  return (
    <section className="card space-y-3 border-moss/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{kind === "email" ? "Send an email" : "Send to Slack"}</h2>
        <button className="btn btn-sm btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {prefill ? <p className="text-xs text-muted">Claude filled this in from your request. Check it, then press Send. Nothing is sent until you do.</p> : null}
      {!connected ? (
        <Notice tone="warn">{kind === "email" ? "Gmail is not connected. Connect it in Settings." : "Slack is not connected. Connect it in Settings."}</Notice>
      ) : kind === "email" ? (
        <p className="text-xs text-muted">Sent from {config?.gmail}.</p>
      ) : null}

      <Field label={kind === "email" ? "To" : "Channel or person"} hint={kind === "email" ? "Separate several addresses with commas." : "For example #warehouse, @maria or maria@company.com."}>
        <input className="field" value={to} onChange={(event) => setTo(event.target.value)} maxLength={1000} />
      </Field>
      {kind === "email" ? (
        <Field label="Subject">
          <input className="field" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} />
        </Field>
      ) : null}
      <Field label={kind === "email" ? "Message" : "Message (optional with a file)"}>
        <textarea className="field" rows={kind === "email" ? 6 : 4} value={body} onChange={(event) => setBody(event.target.value)} maxLength={20_000} />
      </Field>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink/80">Attach</legend>
        {files.length === 0 ? <p className="text-xs text-muted">No files in this chat yet. Ask for a CSV, Excel or JSON file first.</p> : null}
        <div className="space-y-1">
          {files.map((file) => (
            <label key={file.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(file.id)}
                onChange={() => setPicked((list) => (list.includes(file.id) ? list.filter((id) => id !== file.id) : [...list, file.id]))}
              />
              {file.name} <span className="text-xs text-muted">({file.rows} rows)</span>
            </label>
          ))}
        </div>
        {kind === "slack" && picked.length > 0 ? (
          <p className="mt-1.5 text-xs text-muted">Files in Slack need the files:write scope on the Slack app. If it is missing, only the message is posted.</p>
        ) : null}
      </fieldset>

      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}

      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          type="button"
          disabled={busy || sent || !connected || !to.trim() || (kind === "email" ? !subject.trim() || !body.trim() : !body.trim() && picked.length === 0)}
          onClick={() => void send()}
        >
          {busy ? <Spinner /> : sent ? "Sent" : "Send"}
        </button>
        {sent ? (
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Done
          </button>
        ) : null}
      </div>
    </section>
  );
}
