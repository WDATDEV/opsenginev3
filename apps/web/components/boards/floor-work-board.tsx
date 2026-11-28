"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PackingBoard } from "@/components/boards/packing-board";
import { PickingBoard } from "@/components/boards/picking-board";
import { ReceivingBoard } from "@/components/boards/receiving-board";
import { SortingBoard } from "@/components/boards/sorting-board";
import { UnloadingBoard } from "@/components/boards/unloading-board";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Notice, PageTitle, Segmented, SkeletonList, Stat, StatGrid, useResource } from "@/components/ui";

// One page for all floor work on jobs. A filter picks which kind of work to show.
export const FLOOR_WORK_KINDS = [
  ["receiving", "Receiving"],
  ["unloading", "Unloading"],
  ["packing", "Packing"],
  ["picking", "Picking"],
  ["sorting", "Sorting"],
] as const;

// Work with no board of its own. It is a timed task on a job; this view lists those tasks.
// [service, work kind code, label]
export const TASK_WORK_KINDS = [
  ["qc", "qc_check", "Quality check"],
  ["putaway", "putaway", "Putaway"],
  ["returns", "returns", "Returns"],
  ["replenishment", "replenish", "Replenishment"],
  ["cycle_count", "cycle_count", "Cycle count"],
] as const;

/** Every service that has a place on the Floor work page. */
export const FLOOR_WORK_SERVICES = [...FLOOR_WORK_KINDS.map(([kind]) => kind), ...TASK_WORK_KINDS.map(([service]) => service)];

type Kind = (typeof FLOOR_WORK_KINDS)[number][0] | (typeof TASK_WORK_KINDS)[number][0];

// Floor staff cannot read jobs, so they only get the boards.
function canReadJobs(role?: string) {
  return Boolean(role) && role !== "warehouse_employee";
}

export function FloorWorkBoard({ client, services }: { client?: { id: string; name: string }; services?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const user = useSession();
  const on = (service: string) => !services || services.includes(service);
  const options: (readonly [Kind, string])[] = [
    ...FLOOR_WORK_KINDS.filter(([kind]) => on(kind)),
    ...(canReadJobs(user?.role) ? TASK_WORK_KINDS.filter(([service]) => on(service)).map(([service, , label]) => [service, label] as const) : []),
  ];

  if (options.length === 0) {
    return (
      <div className="card">
        <EmptyRow title="No floor work is turned on">Turn on a kind of work in this client&apos;s settings.</EmptyRow>
      </div>
    );
  }

  const asked = params.get("type");
  const kind: Kind = options.find(([code]) => code === asked)?.[0] ?? options[0][0];
  const taskKind = TASK_WORK_KINDS.find(([service]) => service === kind) ?? null;

  function choose(next: Kind) {
    const query = new URLSearchParams(params.toString());
    query.set("type", next);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div className="mb-4">
        <Segmented label="Kind of work" options={options} value={kind} onChange={choose} />
      </div>
      {kind === "receiving" ? <ReceivingBoard client={client} /> : null}
      {kind === "unloading" ? <UnloadingBoard client={client} /> : null}
      {kind === "packing" ? <PackingBoard client={client} /> : null}
      {kind === "picking" ? <PickingBoard client={client} /> : null}
      {kind === "sorting" ? <SortingBoard client={client} /> : null}
      {taskKind ? <TaskWorkBoard client={client} code={taskKind[1]} label={taskKind[2]} /> : null}
    </div>
  );
}

type TaskJobs = {
  jobs: {
    id: string;
    reference: string;
    title: string;
    status: string;
    clientId: string;
    clientName: string;
    tasks: {
      id: string;
      title: string;
      status: string;
      dueOn: string | null;
      assigneeName: string | null;
      startAt: string | null;
      activityCode: string | null;
      started: boolean;
    }[];
  }[];
};

function when(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function TaskWorkBoard({ client, code, label }: { client?: { id: string; name: string }; code: string; label: string }) {
  const board = useResource<TaskJobs>("/jobs");
  const rows = (board.data?.jobs ?? [])
    .filter((job) => !client || job.clientId === client.id)
    .flatMap((job) => job.tasks.filter((task) => task.activityCode === code).map((task) => ({ job, task })));
  const open = rows.filter(({ task }) => task.status !== "done");
  const unassigned = open.filter(({ task }) => !task.assigneeName);
  const jobsHref = client ? `/clients/${client.id}/jobs` : "/jobs";

  return (
    <div>
      <PageTitle
        kicker={label}
        title={client ? `${label} for ${client.name}` : label}
        detail={`${label} is timed work on a job. Add it on the job's Tasks tab, and the person starts it from the floor phone.`}
        actions={
          <Link className="btn btn-ghost" href={jobsHref}>
            Open jobs
          </Link>
        }
      />
      {board.error ? (
        <div className="mb-4">
          <Notice tone="bad">{board.error}</Notice>
        </div>
      ) : null}
      <StatGrid columns={3}>
        <Stat label="Open tasks" value={open.length} tone={open.length ? "ok" : undefined} />
        <Stat label="Open with nobody assigned" value={unassigned.length} tone={unassigned.length ? "warn" : undefined} />
        <Stat label="Done" value={rows.length - open.length} />
      </StatGrid>
      {board.loading && !board.data ? <SkeletonList rows={3} /> : null}
      {board.data && rows.length === 0 ? (
        <div className="card">
          <EmptyRow title={`No ${label.toLowerCase()} tasks yet`}>
            On a job, open Tasks, choose {label} as the type, and add it.
          </EmptyRow>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className="card divide-y divide-black/5">
          {rows.map(({ job, task }) => (
            <li key={task.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{task.title}</p>
                <p className="text-sm text-muted">
                  {[client ? null : job.clientName, `${job.reference} · ${job.title}`, task.assigneeName ?? "Unassigned"]
                    .filter(Boolean)
                    .join(" · ")}
                  {task.startAt && !task.started && task.status !== "done" ? ` · starts ${when(task.startAt)}` : ""}
                  {task.dueOn ? ` · due ${task.dueOn}` : ""}
                </p>
              </div>
              {task.status === "done" ? (
                <Badge>Done</Badge>
              ) : (
                <Badge tone="ok" dot>
                  Open
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
