"use client";

import { Notice, PageTitle, useResource } from "@/components/ui";
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

  return (
    <div>
      <PageTitle
        kicker="Report"
        title="Time on each project"
        detail="Finished and running time, by the person and the project. A pause keeps the minutes already worked. The bill uses the basis set on the project."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {board.data ? (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-3">
            <article className="card p-4">
              <p className="text-sm text-muted">Time recorded</p>
              <p className="font-mono text-2xl">{hours(board.data.minutes)}</p>
            </article>
            <article className="card p-4">
              <p className="text-sm text-muted">Projects</p>
              <p className="font-mono text-2xl">{board.data.projects.length}</p>
            </article>
            <article className="card p-4">
              <p className="text-sm text-muted">Approved to bill</p>
              <p className="font-mono text-2xl">
                {money(board.data.projects.reduce((sum, project) => sum + project.approvedCents, 0))}
              </p>
            </article>
          </section>
          <section className="card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-black/[0.03] text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Project</th>
                  <th className="px-4 py-3 font-medium">Bill</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Crew</th>
                </tr>
              </thead>
              <tbody>
                {board.data.projects.map((project) => (
                  <tr key={project.id} className="border-t border-black/5">
                    <td className="px-4 py-3">
                      <div className="font-medium">{project.title}</div>
                      <div className="font-mono text-xs text-muted">{project.reference}</div>
                    </td>
                    <td className="px-4 py-3">{billBasisLabel(project.billBasis)}</td>
                    <td className="px-4 py-3">
                      {hours(project.minutes)}
                      {project.running ? <div className="text-xs text-moss">Still running</div> : null}
                    </td>
                    <td className="px-4 py-3">{project.employees.length ? project.employees.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {board.data.lines.length ? (
            <section className="card overflow-hidden">
              <h2 className="px-4 pt-4 font-semibold">Each stretch of work</h2>
              <table className="mt-2 w-full text-left text-sm">
                <thead className="bg-black/[0.03] text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Person</th>
                    <th className="px-4 py-3 font-medium">Project</th>
                    <th className="px-4 py-3 font-medium">Task</th>
                    <th className="px-4 py-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {board.data.lines.map((line, index) => (
                    <tr key={`${line.jobReference}-${line.employeeName}-${index}`} className="border-t border-black/5">
                      <td className="px-4 py-3">{line.employeeName}</td>
                      <td className="px-4 py-3 font-mono text-xs">{line.jobReference}</td>
                      <td className="px-4 py-3">{line.taskName}</td>
                      <td className="px-4 py-3">
                        {hours(line.minutes)}
                        {line.running ? " · running" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
