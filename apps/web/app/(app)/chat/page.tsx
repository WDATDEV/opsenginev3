"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, Field, Notice, PageTitle, SkeletonList, Spinner, timeAgo, useResource } from "@/components/ui";
import { api, ApiError, post } from "@/lib/api";

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
type Send = { kind: "email" | "slack"; to: string; at: string; ok: boolean; note: string; file: string | null };
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "working" | "done" | "failed";
  error: string | null;
  lookups: { tool: string; summary: string }[];
  proposal: Proposal | null;
  sends: Send[];
  createdAt: string;
};
type FileInfo = { id: string; messageId: string; name: string; format: string; rows: number; columns: string[]; size: number };
type Detail = { thread: Thread; messages: Message[]; files: FileInfo[] };
type Config = { warehance: boolean; claude: boolean; gmail: string | null; slack: boolean };
type Clients = { connected: boolean; clients: { id: number; name: string }[]; error?: string };
type Panel = { messageId: string; kind: "email" | "slack"; prefill: Proposal | null };

const EXAMPLES = [
  "How many orders shipped last week?",
  "List all orders that are on hold",
  "Make an Excel file of this month's shipments",
  "Which products are low on stock?",
  "List SKUs with quantity greater than 0 as a CSV",
];

function size(bytes: number) {
  return bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function stamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function reason(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export default function ChatPage() {
  const user = useSession();
  const owner = user?.role === "owner";
  const config = useResource<Config>(owner ? "/mail/chat/config" : null);
  const clients = useResource<Clients>(owner ? "/mail/chat/clients" : null);
  const threads = useResource<Thread[]>(owner ? "/mail/chat/threads" : null);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [showList, setShowList] = useState(false);
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

  if (!owner) return <Notice tone="bad">Chat is for the warehouse owner.</Notice>;

  const thread = detail?.thread ?? null;
  const activeScope = thread ? { id: thread.warehanceClientId, name: thread.warehanceClientName } : scope;
  const activeModel = thread?.model ?? model;
  const setupGaps = config.data
    ? [
        !config.data.warehance ? "the Warehance bot" : null,
        !config.data.claude ? "the Claude API key" : null,
      ].filter(Boolean)
    : [];

  return (
    <div>
      <PageTitle
        kicker="Owner only"
        title="Chat"
        detail="Ask about your Warehance data. Get lists as CSV, Excel or JSON, then email them or post them in Slack. Old chats are kept."
      />
      {setupGaps.length > 0 ? (
        <div className="mb-4">
          <Notice tone="warn">Add {setupGaps.join(" and ")} in Settings before chatting.</Notice>
        </div>
      ) : null}
      {clients.data && clients.data.connected && clients.data.error ? (
        <div className="mb-4">
          <Notice tone="warn">The client list could not be loaded ({clients.data.error}). You can still chat about all clients.</Notice>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        {/* Past chats */}
        <aside className={`${showList ? "block" : "hidden"} md:block`}>
          <button className="btn btn-primary mb-3 w-full" type="button" onClick={() => open(null)}>
            New chat
          </button>
          {threads.loading && !threads.data ? <SkeletonList rows={4} /> : null}
          {threads.error ? <Notice tone="bad">{threads.error}</Notice> : null}
          {threads.data && threads.data.length === 0 ? <p className="px-1 text-sm text-muted">No chats yet.</p> : null}
          <ul className="space-y-1">
            {(threads.data ?? []).map((item) => (
              <li key={item.id}>
                <div
                  className={`group flex items-start gap-1 rounded-xl px-3 py-2 text-sm transition-colors ${
                    item.id === selected ? "bg-moss/10" : "hover:bg-black/5"
                  }`}
                >
                  <button className="min-w-0 flex-1 text-left" type="button" onClick={() => open(item.id)}>
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {item.warehanceClientName ?? "All clients"} · {timeAgo(item.updatedAt)}
                    </span>
                  </button>
                  <button
                    className="flex-none rounded-md px-1.5 text-muted opacity-60 hover:bg-black/5 hover:text-rust group-hover:opacity-100"
                    type="button"
                    aria-label={`Delete ${item.title}`}
                    onClick={() => void remove(item)}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        {/* The conversation */}
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button className="btn btn-sm btn-ghost md:hidden" type="button" onClick={() => setShowList((value) => !value)}>
              {showList ? "Hide chats" : "Past chats"}
            </button>
            {thread ? (
              renaming !== null ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (renaming.trim()) void change({ title: renaming.trim() });
                    setRenaming(null);
                  }}
                >
                  <input className="field h-9 w-56" value={renaming} onChange={(event) => setRenaming(event.target.value)} maxLength={120} autoFocus aria-label="Chat name" />
                  <button className="btn btn-sm" type="submit">Save</button>
                </form>
              ) : (
                <button className="max-w-xs truncate text-sm font-semibold hover:underline" type="button" onClick={() => setRenaming(thread.title)} title="Rename">
                  {thread.title}
                </button>
              )
            ) : (
              <span className="text-sm font-semibold">New chat</span>
            )}
            <span className="flex-1" />
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Client</span>
              <select
                className="field h-9 w-48"
                value={activeScope.id ? String(activeScope.id) : ""}
                disabled={!clients.data?.connected}
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
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Model</span>
              <select
                className="field h-9 w-32"
                value={activeModel}
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

          {activeScope.id ? (
            <p className="mb-3 text-xs text-muted">Lookups are limited to {activeScope.name ?? `client ${activeScope.id}`}.</p>
          ) : (
            <p className="mb-3 text-xs text-muted">Lookups can cover every client. Pick a client to limit them to one.</p>
          )}

          <div className="card flex min-h-[22rem] flex-col p-4">
            <div className="max-h-[56vh] min-h-[16rem] flex-1 space-y-4 overflow-y-auto pr-1" aria-live="polite">
              {selected && !detail && !loadError ? <SkeletonList rows={3} /> : null}
              {loadError ? <Notice tone="bad">{loadError}</Notice> : null}
              {!selected ? (
                <EmptyState title="Ask anything about your warehouse">
                  <p>Orders, shipments, stock, clients. Ask for a file when you want the full list.</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {EXAMPLES.map((example) => (
                      <button key={example} className="btn btn-sm btn-ghost" type="button" disabled={!ready} onClick={() => setText(example)}>
                        {example}
                      </button>
                    ))}
                  </div>
                </EmptyState>
              ) : null}
              {detail?.messages.map((message) => (
                <Bubble
                  key={message.id}
                  message={message}
                  files={detail.files.filter((file) => file.messageId === message.id)}
                  onSend={(kind, prefill) => setPanel({ messageId: message.id, kind, prefill })}
                  onFilesChanged={() => void load(detail.thread.id)}
                />
              ))}
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
              <div className="mt-3">
                <Notice tone="bad">{error}</Notice>
              </div>
            ) : null}

            <form
              className="mt-3 flex items-end gap-2 border-t border-black/10 pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(text);
              }}
            >
              <textarea
                className="field min-h-[2.75rem] flex-1 resize-y"
                rows={2}
                value={text}
                maxLength={8000}
                placeholder={ready ? "Ask a question, or ask for a file…" : "Finish setup in Settings first"}
                disabled={!ready || sending}
                aria-label="Your message"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit(text);
                  }
                }}
              />
              <button className="btn btn-primary" type="submit" disabled={!ready || sending || working || !text.trim()}>
                {sending || working ? <Spinner /> : "Send"}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one message

function Bubble({
  message,
  files,
  onSend,
  onFilesChanged,
}: {
  message: Message;
  files: FileInfo[];
  onSend: (kind: "email" | "slack", prefill: Proposal | null) => void;
  onFilesChanged: () => void;
}) {
  const [showLookups, setShowLookups] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-moss px-3.5 py-2.5 text-sm text-paper">{message.content}</p>
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="max-w-[92%] space-y-2">
        {message.status === "working" ? (
          <div className="rounded-2xl rounded-bl-md bg-black/[0.04] px-3.5 py-2.5 text-sm">
            <Spinner label={message.lookups.length > 0 ? "Working on it…" : "Looking things up…"} />
            {message.lookups.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-xs text-muted">
                {message.lookups.slice(-4).map((item, index) => (
                  <li key={`${item.summary}-${index}`}>{item.summary}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {message.status === "failed" ? <Notice tone="bad">{message.error ?? "That did not work."}</Notice> : null}
        {message.status === "done" ? (
          <p className="whitespace-pre-wrap rounded-2xl rounded-bl-md bg-black/[0.04] px-3.5 py-2.5 text-sm leading-6">{message.content}</p>
        ) : null}

        {files.map((file) => (
          <ChatFile key={file.id} file={file} onSaved={onFilesChanged} />
        ))}

        {message.status === "done" ? (
          <div className="flex flex-wrap items-center gap-2">
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

function FileEditor({ fileId, onClose, onSaved }: { fileId: string; onClose: () => void; onSaved: () => void }) {
  const [table, setTable] = useState<TableFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
      onSaved();
    } catch (err) {
      setError(reason(err, "Could not save that file."));
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
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="button" disabled={busy || table.cells.length === 0} onClick={() => void save()}>
          {busy ? <Spinner /> : "Save a copy"}
        </button>
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
