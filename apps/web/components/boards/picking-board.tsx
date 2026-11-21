"use client";

import { useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Avatar, EmptyRow, Field, Flash, isToday, MoreButton, Notice, PageTitle, Panel, SearchBox, SkeletonList, Stat, StatGrid, timeAgo, usePaged, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  events: {
    id: string;
    batchCode: string;
    sku: string;
    qty: number;
    via: string;
    pickedAt: string;
    employeeName: string;
    deviceCode: string;
    clientId: string | null;
  }[];
};

export function PickingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/picking");
  const user = useSession();
  const manage = canManage(user?.role);
  const skuInput = useRef<HTMLInputElement | null>(null);
  const [badge, setBadge] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>("/tracking/picking", {
        badge,
        batchCode,
        sku,
        qty,
        ...(client ? { clientId: client.id } : {}),
      });
      setMessage(result.message);
      setSku("");
      setQty(1);
      board.reload();
      skuInput.current?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that pick.");
    }
  }

  const events = (board.data?.events ?? []).filter((item) => !client || item.clientId === client.id);
  const today = events.filter((item) => isToday(item.pickedAt));
  const query = search.trim().toLowerCase();
  const list = events.filter((item) => !query || `${item.sku} ${item.batchCode} ${item.employeeName}`.toLowerCase().includes(query));
  const paged = usePaged(list);

  return (
    <div>
      <PageTitle
        kicker="Picking"
        title={client ? `Picking for ${client.name}` : "Who picked what"}
        detail="Scan the picker's badge, then record the batch, SKU, and quantity."
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <StatGrid>
        <Stat label="Pick lines today" value={today.length} tone="ok" />
        <Stat label="Units today" value={today.reduce((sum, item) => sum + item.qty, 0).toLocaleString()} />
        <Stat label="Pickers today" value={new Set(today.map((item) => item.employeeName)).size} />
        <Stat label="Lines, all time" value={events.length.toLocaleString()} />
      </StatGrid>
      <div className={`grid items-start gap-5 ${manage ? "lg:grid-cols-[21rem_minmax(0,1fr)]" : ""}`}>
        {manage ? (
          <form className="card space-y-3 p-4 sm:p-5 lg:sticky lg:top-6" onSubmit={submit}>
            <h2 className="font-semibold">Record a pick</h2>
            <Field label="Picker's badge">
              <input className="field font-mono" required autoComplete="off" value={badge} onChange={(event) => setBadge(event.target.value)} placeholder="Scan the badge" />
            </Field>
            <Field label="Batch" hint="Badge and batch stay filled in for the next pick.">
              <input className="field font-mono" required autoComplete="off" value={batchCode} onChange={(event) => setBatchCode(event.target.value)} placeholder="Batch number" />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-3">
              <Field label="SKU">
                <input ref={skuInput} className="field font-mono" required autoComplete="off" value={sku} onChange={(event) => setSku(event.target.value)} placeholder="Scan SKU" />
              </Field>
              <Field label="Qty">
                <input className="field" type="number" min={1} required value={qty} onChange={(event) => setQty(Number(event.target.value))} />
              </Field>
            </div>
            <button className="btn btn-primary w-full" type="submit">
              Record pick
            </button>
          </form>
        ) : null}
        <Panel title="Picks" count={list.length} actions={<SearchBox value={search} onChange={setSearch} label="Search picks" placeholder="Search SKU, batch, person" />}>
          {board.loading && !board.data ? <div className="p-4"><SkeletonList rows={3} /></div> : null}
          {board.data && list.length === 0 ? <EmptyRow title={query ? "Nothing matches that search" : "No picks recorded yet"}>{query ? null : "Recorded picks will appear here."}</EmptyRow> : null}
          <ul className="divide-y divide-black/5">
            {paged.shown.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <Avatar name={item.employeeName} active />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium">{item.sku}</p>
                  <p className="truncate text-sm text-muted">
                    {item.employeeName} · {item.batchCode}
                    {item.deviceCode ? ` · ${item.deviceCode}` : ""}
                  </p>
                </div>
                <div className="flex-none text-right">
                  <p className="text-sm tabular-nums">× {item.qty}</p>
                  <time className="text-xs text-muted" dateTime={item.pickedAt} title={when(item.pickedAt)}>
                    {timeAgo(item.pickedAt)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
          <MoreButton hidden={paged.hidden} onClick={paged.more} />
        </Panel>
      </div>
    </div>
  );
}
