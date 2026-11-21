"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Flash, MoreButton, Notice, PageTitle, Panel, SearchBox, SkeletonList, timeAgo, usePaged, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Task = {
  id: string;
  title: string;
  details: string | null;
  status: string;
  clientName: string | null;
  createdAt: string;
};

export default function WorkPage() {
  const board = useResource<Task[]>("/work/tasks");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function close(task: Task) {
    setError(null);
    setMessage(null);
    setBusy(task.id);
    try {
      await post(`/work/tasks/${task.id}/done`, {});
      setMessage(`${task.title} is done.`);
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close that follow-up.");
    } finally {
      setBusy(null);
    }
  }

  const query = search.trim().toLowerCase();
  const list = (board.data ?? []).filter((task) => !query || `${task.title} ${task.details ?? ""} ${task.clientName ?? ""}`.toLowerCase().includes(query));
  const paged = usePaged(list);

  return (
    <div>
      <PageTitle kicker="Time tracking" title="Follow-ups" detail="Short counts, missing crew, and carrier-bin problems from the floor that still need someone to act." />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      {board.loading && !board.data ? <SkeletonList rows={3} /> : null}
      {board.data ? (
        <Panel title="Needs attention" count={list.length} actions={<SearchBox value={search} onChange={setSearch} label="Search follow-ups" placeholder="Search task or client" />}>
          {list.length === 0 ? (
            <EmptyRow title={query ? "Nothing matches that search" : "All caught up"}>{query ? null : "Count differences from the floor will appear here."}</EmptyRow>
          ) : (
            <ul className="divide-y divide-black/5">
              {paged.shown.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                  <div className="min-w-0 flex-1 basis-64">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{task.title}</h3>
                      <Badge tone={task.status === "done" ? "ok" : "warn"} dot>
                        {task.status === "done" ? "Done" : "Open"}
                      </Badge>
                    </div>
                    {task.details ? <p className="mt-0.5 text-sm text-muted">{task.details}</p> : null}
                    <p className="mt-1 text-xs text-muted" title={when(task.createdAt)}>
                      {task.clientName ?? "No client"} · {timeAgo(task.createdAt)}
                    </p>
                  </div>
                  {canManage(user?.role) && task.status !== "done" ? (
                    <button className="btn btn-sm" type="button" disabled={busy === task.id} onClick={() => void close(task)}>
                      Mark done
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <MoreButton hidden={paged.hidden} onClick={paged.more} />
        </Panel>
      ) : null}
    </div>
  );
}
