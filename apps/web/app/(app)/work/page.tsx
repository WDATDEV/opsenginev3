"use client";

import { useSession } from "@/components/shell";
import { Notice, PageTitle, useResource } from "@/components/ui";
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

  async function close(id: string) {
    try {
      await post(`/work/tasks/${id}/done`, {});
      board.reload();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not close that follow-up.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Work"
        title="Follow-ups from the floor"
        detail="A short count, a missing crew, or a gaylord problem becomes a task. The work module holds it. Tracking does not keep a second copy."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      <div className="space-y-3">
        {board.data?.length === 0 ? (
          <div className="card p-6 text-muted">No open follow-ups. Variance counts will land here.</div>
        ) : null}
        {board.data?.map((task) => (
          <article key={task.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-muted">{task.status}</p>
              <h2 className="text-lg font-semibold">{task.title}</h2>
              <p className="text-sm text-muted">{task.details}</p>
              <p className="mt-1 text-xs text-muted">
                {task.clientName ?? "No client"} · {when(task.createdAt)}
              </p>
            </div>
            {canManage(user?.role) && task.status !== "done" ? (
              <button className="btn btn-ghost" type="button" onClick={() => close(task.id)}>
                Mark done
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
