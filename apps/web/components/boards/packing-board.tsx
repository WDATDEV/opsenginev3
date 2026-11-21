"use client";

import { useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Avatar, Badge, EmptyRow, Field, Flash, isToday, MoreButton, Notice, PageTitle, Panel, SearchBox, SkeletonList, Stat, StatGrid, timeAgo, usePaged, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  events: {
    id: string;
    orderNumber: string;
    employeeName: string;
    loginMismatch: boolean;
    sentence: string;
    packedAt: string;
    units: number;
    clientId: string | null;
  }[];
};

export function PackingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/packing");
  const user = useSession();
  const manage = canManage(user?.role);
  const orderInput = useRef<HTMLInputElement | null>(null);
  const [orderNumber, setOrderNumber] = useState("");
  const [badge, setBadge] = useState("");
  const [units, setUnits] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>("/tracking/packing", {
        orderNumber,
        badge,
        units,
        ...(client ? { clientId: client.id } : {}),
      });
      setMessage(result.message);
      setOrderNumber("");
      setUnits(1);
      board.reload();
      orderInput.current?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that pack.");
    }
  }

  const events = (board.data?.events ?? []).filter((item) => !client || item.clientId === client.id);
  const today = events.filter((item) => isToday(item.packedAt));
  const query = search.trim().toLowerCase();
  const list = events.filter((item) => !query || `${item.orderNumber} ${item.employeeName}`.toLowerCase().includes(query));
  const paged = usePaged(list);

  return (
    <div>
      <PageTitle
        kicker="Packing"
        title={client ? `Packing for ${client.name}` : "Who packed the order"}
        detail="Enter the order, scan the packer's badge, and finish the pack."
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <StatGrid>
        <Stat label="Orders today" value={today.length} tone="ok" />
        <Stat label="Units today" value={today.reduce((sum, item) => sum + item.units, 0).toLocaleString()} />
        <Stat label="Packers today" value={new Set(today.map((item) => item.employeeName)).size} />
        <Stat label="Orders, all time" value={events.length.toLocaleString()} />
      </StatGrid>
      <div className={`grid items-start gap-5 ${manage ? "lg:grid-cols-[21rem_minmax(0,1fr)]" : ""}`}>
        {manage ? (
          <form className="card space-y-3 p-4 sm:p-5 lg:sticky lg:top-6" onSubmit={submit}>
            <h2 className="font-semibold">Record a pack</h2>
            <Field label="Order">
              <input ref={orderInput} className="field font-mono" required autoComplete="off" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} placeholder="Scan or type the order" />
            </Field>
            <Field label="Packer's badge" hint="Stays filled in for the next order.">
              <input className="field font-mono" required autoComplete="off" value={badge} onChange={(event) => setBadge(event.target.value)} placeholder="Scan the badge" />
            </Field>
            <Field label="Units">
              <input className="field" type="number" min={1} required value={units} onChange={(event) => setUnits(Number(event.target.value))} />
            </Field>
            <button className="btn btn-primary w-full" type="submit">
              Finish pack
            </button>
          </form>
        ) : null}
        <Panel title="Packed orders" count={list.length} actions={<SearchBox value={search} onChange={setSearch} label="Search packed orders" placeholder="Search order or person" />}>
          {board.loading && !board.data ? <div className="p-4"><SkeletonList rows={3} /></div> : null}
          {board.data && list.length === 0 ? <EmptyRow title={query ? "Nothing matches that search" : "No orders packed yet"}>{query ? null : "Finished packs will appear here."}</EmptyRow> : null}
          <ul className="divide-y divide-black/5">
            {paged.shown.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <Avatar name={item.employeeName} active />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium">{item.orderNumber}</p>
                  <p className="truncate text-sm text-muted">{item.employeeName}</p>
                </div>
                {item.loginMismatch ? <Badge tone="warn" dot>Badge mismatch</Badge> : null}
                <div className="flex-none text-right">
                  <p className="text-sm tabular-nums">
                    {item.units} {item.units === 1 ? "unit" : "units"}
                  </p>
                  <time className="text-xs text-muted" dateTime={item.packedAt} title={when(item.packedAt)}>
                    {timeAgo(item.packedAt)}
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
