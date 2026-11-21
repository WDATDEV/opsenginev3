"use client";

import { Badge, EmptyRow, Notice, PageTitle, Panel, Progress, SkeletonList, Stat, StatGrid, useResource } from "@/components/ui";
import { billBasisLabel, money } from "@/lib/api";

type Summary = {
  clientName: string;
  minutes: number;
  lines: {
    employeeName: string;
    jobReference: string;
    jobTitle: string;
    taskName: string;
    minutes: number;
    running: boolean;
  }[];
  projects: {
    id: string;
    reference: string;
    title: string;
    status: string;
    billBasis: string;
    minutes: number;
    running: boolean;
    employees: string[];
    draftCents: number;
    approvedCents: number;
  }[];
};

function hours(minutes: number) {
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (whole === 0) return `${rest} min`;
  return `${whole} h ${rest} min`;
}

export function ReportBoard({ clientId }: { clientId: string }) {
  const board = useResource<Summary>(`/clients/${clientId}/summary`);
  const data = board.data;
  const projects = data ? [...data.projects].sort((a, b) => b.minutes - a.minutes) : [];
  const longest = Math.max(1, ...projects.map((project) => project.minutes));

  return (
    <div>
      <PageTitle kicker="Report" title="Time on each project" detail="Finished and running time by project and person. A pause keeps the minutes already worked." />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      {board.loading && !data ? <SkeletonList rows={3} /> : null}
      {data ? (
        <div className="space-y-5">
          <StatGrid>
            <Stat label="Time recorded" value={hours(data.minutes)} tone="ok" />
            <Stat label="Projects" value={data.projects.length} note={`${data.projects.filter((project) => project.running).length} running now`} />
            <Stat label="Draft charges" value={money(data.projects.reduce((sum, project) => sum + project.draftCents, 0))} note="waiting for approval" />
            <Stat label="Approved to bill" value={money(data.projects.reduce((sum, project) => sum + project.approvedCents, 0))} />
          </StatGrid>

          <Panel title="Projects" count={projects.length}>
            {projects.length === 0 ? <EmptyRow title="No projects yet">Time appears here once work is recorded on a job.</EmptyRow> : null}
            <ul className="divide-y divide-black/5">
              {projects.map((project) => (
                <li key={project.id} className="px-4 py-3.5 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{project.title}</h3>
                        {project.running ? <Badge tone="ok" dot>Running</Badge> : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        <span className="font-mono">{project.reference}</span> · {billBasisLabel(project.billBasis)}
                      </p>
                    </div>
                    <p className="font-mono text-sm tabular-nums">{hours(project.minutes)}</p>
                  </div>
                  <div className="mt-2">
                    <Progress value={project.minutes} max={longest} label={`${project.title}: ${hours(project.minutes)}`} />
                  </div>
                  <p className="mt-1.5 truncate text-xs text-muted">{project.employees.length ? project.employees.join(", ") : "No crew recorded"}</p>
                </li>
              ))}
            </ul>
          </Panel>

          {data.lines.length ? (
            <details className="card group overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 font-semibold sm:px-5 [&::-webkit-details-marker]:hidden">
                Each stretch of work ({data.lines.length})
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 flex-none text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 8 5 5 5-5" />
                </svg>
              </summary>
              <div className="overflow-x-auto border-t border-black/5">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead className="bg-black/[0.03] text-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium sm:px-5">Person</th>
                      <th className="px-4 py-2.5 font-medium">Project</th>
                      <th className="px-4 py-2.5 font-medium">Task</th>
                      <th className="px-4 py-2.5 text-right font-medium sm:px-5">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((line, index) => (
                      <tr key={`${line.jobReference}-${line.employeeName}-${index}`} className="border-t border-black/5">
                        <td className="px-4 py-2.5 sm:px-5">{line.employeeName}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{line.jobReference}</td>
                        <td className="px-4 py-2.5">{line.taskName}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums sm:px-5">
                          {hours(line.minutes)}
                          {line.running ? <span className="text-moss"> · running</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
