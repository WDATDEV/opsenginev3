"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

type Board = {
  loads: {
    id: string;
    reference: string;
    kind: string;
    dock: string;
    status: string;
    seal: string | null;
    palletCount: number | null;
    cartonCount: number | null;
    clientId?: string | null;
    clientName?: string | null;
    jobReference?: string | null;
    crew: {
      employeeId: string;
      name: string;
      source: string;
      startedAt: string;
      endedAt: string | null;
      active: boolean;
    }[];
  }[];
  people: { id: string; name: string }[];
};

export function UnloadingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/unloading");
  const jobs = useResource<{ jobs: { id: string; reference: string; clientId: string; clientName: string; status: string }[] }>("/jobs");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [dock, setDock] = useState("Dock 1");
  const [kind, setKind] = useState<"truck" | "container">("truck");
  const [jobId, setJobId] = useState("");

  const openJobs = (jobs.data?.jobs ?? []).filter((job) => job.status !== "done" && (!client || job.clientId === client.id));

  useEffect(() => {
    if (openJobs.some((job) => job.id === jobId)) return;
    setJobId(openJobs[0]?.id ?? "");
  }, [jobId, openJobs]);

  async function act(path: string, body: unknown) {
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message?: string }>(path, body);
      setMessage(result.message ?? "Saved.");
      board.reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the load.");
      return false;
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Unloading"
        title={client ? `Unloading for ${client.name}` : "Who worked the truck"}
        detail={
          client
            ? `Loads here belong to ${client.name}. A person can badge onto the trailer, or a supervisor can enter the crew.`
            : "A person can badge onto the trailer, a lead can add a name, or a supervisor can enter the paper crew list. Each one has a start and an end."
        }
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManage(user?.role) ? (
        <form
          className="card mb-6 grid gap-3 p-4 md:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            const trailer = reference.trim();
            if (!trailer) {
              setMessage(null);
              setError("Enter the trailer or container number.");
              return;
            }
            if (!jobId) {
              setMessage(null);
              setError("Open a job for this client before a load can arrive.");
              return;
            }
            void act("/tracking/unloading", {
              reference: trailer,
              kind,
              dock,
              jobId,
            }).then((saved) => {
              if (saved) setReference("");
            });
          }}
        >
          <Field label="Job">
            <select className="field" value={jobId} onChange={(event) => setJobId(event.target.value)}>
              {openJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {client ? job.reference : `${job.clientName} · ${job.reference}`}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Trailer or container">
            <input className="field" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Trailer number" />
          </Field>
          <Field label="Kind">
            <select className="field" value={kind} onChange={(event) => setKind(event.target.value as "truck" | "container")}>
              <option value="truck">Truck</option>
              <option value="container">Container</option>
            </select>
          </Field>
          <Field label="Dock">
            <input className="field" value={dock} onChange={(event) => setDock(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Arrive load
            </button>
          </div>
        </form>
      ) : null}
      <div className="space-y-4">
        {board.data?.loads
          .filter((load) => !client || load.clientId === client.id)
          .map((load) => (
          <LoadCard key={load.id} load={load} people={board.data?.people ?? []} manage={canManage(user?.role)} onAct={act} />
        ))}
      </div>
    </div>
  );
}

function LoadCard({
  load,
  people,
  manage,
  onAct,
}: {
  load: Board["loads"][number];
  people: { id: string; name: string }[];
  manage: boolean;
  onAct: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [badge, setBadge] = useState("B-10448");
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? "");
  const [source, setSource] = useState<"badge" | "lead_added" | "paper">("badge");
  const [pallets, setPallets] = useState(8);
  const [cartons, setCartons] = useState(120);

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm">{load.reference}</p>
          <h2 className="text-xl font-semibold capitalize">
            {load.kind} · {load.dock}
          </h2>
          <p className="text-sm text-muted">
            {load.status}
            {load.seal ? ` · seal ${load.seal}` : ""}
            {load.palletCount != null ? ` · ${load.palletCount} pallets / ${load.cartonCount} cartons` : ""}
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {load.crew.map((member) => (
          <li key={`${member.employeeId}-${member.startedAt}`}>
            {member.name} · {member.source.replaceAll("_", " ")} · {when(member.startedAt)}
            {member.endedAt ? ` to ${when(member.endedAt)}` : " · still on the load"}
          </li>
        ))}
        {load.crew.length === 0 ? <li className="text-muted">No crew recorded yet.</li> : null}
      </ul>
      {manage && load.status !== "done" ? (
        <div className="mt-4 grid gap-4 border-t border-black/5 pt-4 lg:grid-cols-2">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void onAct(`/tracking/unloading/${load.id}/crew`, {
                source,
                badge: source === "badge" ? badge : undefined,
                employeeId: source === "badge" ? undefined : employeeId,
              });
            }}
          >
            <Field label="How they were recorded">
              <select className="field" value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
                <option value="badge">Badge onto the load</option>
                <option value="lead_added">Lead added the name</option>
                <option value="paper">Paper crew list</option>
              </select>
            </Field>
            {source === "badge" ? (
              <Field label="Badge">
                <input className="field font-mono" value={badge} onChange={(event) => setBadge(event.target.value)} />
              </Field>
            ) : (
              <Field label="Employee">
                <select className="field" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <button className="btn btn-primary" type="submit">
              Add to crew
            </button>
          </form>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void onAct(`/tracking/unloading/${load.id}/finish`, {
                palletCount: pallets,
                cartonCount: cartons,
              });
            }}
          >
            <Field label="Pallets">
              <input className="field" type="number" min={0} value={pallets} onChange={(event) => setPallets(Number(event.target.value))} />
            </Field>
            <Field label="Cartons">
              <input className="field" type="number" min={0} value={cartons} onChange={(event) => setCartons(Number(event.target.value))} />
            </Field>
            <button className="btn btn-ghost" type="submit">
              Finish unload
            </button>
          </form>
        </div>
      ) : null}
    </article>
  );
}
