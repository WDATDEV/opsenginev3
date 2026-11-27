"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/shell";
import { Avatar, Badge, EmptyRow, Field, Flash, MoreButton, Notice, PageTitle, SearchBox, Segmented, SkeletonList, Stat, StatGrid, usePaged, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";
import { problemHref } from "@/lib/problems";

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
    assigned: { employeeId: string; name: string }[];
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

type View = "active" | "done" | "all";

const VIEWS = [
  ["active", "At the dock"],
  ["done", "Finished"],
  ["all", "All"],
] as const;

const SOURCE_LABELS: Record<string, string> = { badge: "Badged on", lead_added: "Added by lead", paper: "Paper list" };

export function UnloadingBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Board>("/tracking/unloading");
  const jobs = useResource<{ jobs: { id: string; reference: string; clientId: string; clientName: string; status: string }[] }>("/jobs");
  const user = useSession();
  const manage = canManage(user?.role);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [dock, setDock] = useState("Dock 1");
  const [kind, setKind] = useState<"truck" | "container">("truck");
  const [jobId, setJobId] = useState("");
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");

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

  const loads = (board.data?.loads ?? []).filter((load) => !client || load.clientId === client.id);
  const active = loads.filter((load) => load.status !== "done");
  const finished = loads.filter((load) => load.status === "done");
  const query = search.trim().toLowerCase();
  const list = loads.filter(
    (load) =>
      (view === "all" || (view === "done") === (load.status === "done")) &&
      (!query || `${load.reference} ${load.dock} ${load.jobReference ?? ""} ${load.clientName ?? ""}`.toLowerCase().includes(query)),
  );
  const paged = usePaged(list, 10);

  return (
    <div>
      <PageTitle
        kicker="Unloading"
        title={client ? `Unloading for ${client.name}` : "Who worked the truck"}
        detail="Arrive a trailer on a job, record the crew, then finish it with the final counts."
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <StatGrid>
        <Stat label="At the dock" value={active.length} tone="ok" />
        <Stat label="Crew on loads" value={new Set(active.flatMap((load) => load.crew.filter((member) => member.active).map((member) => member.employeeId))).size} />
        <Stat label="Pallets unloaded" value={finished.reduce((sum, load) => sum + (load.palletCount ?? 0), 0).toLocaleString()} note="finished loads" />
        <Stat label="Cartons unloaded" value={finished.reduce((sum, load) => sum + (load.cartonCount ?? 0), 0).toLocaleString()} note="finished loads" />
      </StatGrid>

      {manage ? (
        <form
          className="card mb-5 p-4 sm:p-5"
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
          <h2 className="mb-3 font-semibold">Arrive a load</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_8rem_8rem_auto]">
            <Field label="Job">
              <select className="field" value={jobId} disabled={openJobs.length === 0} onChange={(event) => setJobId(event.target.value)}>
                {openJobs.length === 0 ? <option value="">No open jobs</option> : null}
                {openJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {client ? job.reference : `${job.clientName} · ${job.reference}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Trailer or container">
              <input className="field font-mono" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Trailer number" />
            </Field>
            <Field label="Kind">
              <select className="field" value={kind} onChange={(event) => setKind(event.target.value as "truck" | "container")}>
                <option value="truck">Truck</option>
                <option value="container">Container</option>
              </select>
            </Field>
            <Field label="Dock">
              <input className="field" required value={dock} onChange={(event) => setDock(event.target.value)} />
            </Field>
            <div className="flex items-end">
              <button className="btn btn-primary w-full" type="submit" disabled={openJobs.length === 0}>
                Arrive load
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Show loads" options={VIEWS} value={view} onChange={setView} />
        <SearchBox value={search} onChange={setSearch} label="Search loads" placeholder="Search trailer, dock, job" />
      </div>
      {board.loading && !board.data ? <SkeletonList rows={3} /> : null}
      {board.data && list.length === 0 ? (
        <div className="card">
          <EmptyRow title={query ? "Nothing matches that search" : view === "done" ? "No finished loads" : "Nothing at the dock"}>{query ? null : "Loads appear here once they arrive."}</EmptyRow>
        </div>
      ) : null}
      <div className="space-y-4">
        {paged.shown.map((load) => (
          <LoadCard key={load.id} load={load} people={board.data?.people ?? []} manage={manage} onAct={act} />
        ))}
      </div>
      {paged.hidden > 0 ? <div className="card mt-4 overflow-hidden"><MoreButton hidden={paged.hidden} onClick={paged.more} /></div> : null}
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
  const [badge, setBadge] = useState("");
  const waiting = load.assigned.filter((person) => !load.crew.some((member) => member.employeeId === person.employeeId));
  const [employeeId, setEmployeeId] = useState(waiting[0]?.employeeId ?? people[0]?.id ?? "");
  const [source, setSource] = useState<"badge" | "lead_added" | "paper">(waiting.length > 0 ? "lead_added" : "badge");
  const [pallets, setPallets] = useState(load.palletCount != null ? String(load.palletCount) : "");
  const [cartons, setCartons] = useState(load.cartonCount != null ? String(load.cartonCount) : "");
  const done = load.status === "done";

  return (
    <article className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-lg font-semibold">{load.reference}</h3>
            <Badge tone={done ? "neutral" : "ok"} dot>
              <span className="capitalize">{load.status}</span>
            </Badge>
          </div>
          <p className="mt-0.5 text-sm capitalize text-muted">
            {[load.kind, load.dock, load.clientName, load.jobReference, load.seal ? `Seal ${load.seal}` : null].filter(Boolean).join(" · ")}
          </p>
          {manage ? (
            <a className="mt-1 inline-block text-sm text-moss hover:underline" href={problemHref({ kind: "damage", loadId: load.id, clientId: load.clientId, title: `${load.reference}: ` })}>
              Open a problem
            </a>
          ) : null}
        </div>
        {load.palletCount != null ? (
          <div className="flex gap-4 text-right">
            <div>
              <p className="font-mono text-lg tabular-nums">{load.palletCount}</p>
              <p className="text-xs text-muted">pallets</p>
            </div>
            <div>
              <p className="font-mono text-lg tabular-nums">{load.cartonCount ?? 0}</p>
              <p className="text-xs text-muted">cartons</p>
            </div>
          </div>
        ) : null}
      </div>

      <h4 className="mt-4 text-sm font-medium">Crew</h4>
      {load.crew.length === 0 ? <p className="mt-1 text-sm text-muted">No crew recorded yet.</p> : null}
      <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
        {load.crew.map((member) => (
          <li key={`${member.employeeId}-${member.startedAt}`} className="flex items-center gap-2.5 rounded-xl bg-black/[0.025] px-2.5 py-2">
            <Avatar name={member.name} active={!member.endedAt} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{member.name}</p>
              <p className="truncate text-xs text-muted">
                {SOURCE_LABELS[member.source] ?? member.source} · {when(member.startedAt)}
                {member.endedAt ? ` to ${when(member.endedAt)}` : " · on the load"}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {waiting.length > 0 ? (
        <div className="mt-3">
          <Notice tone="warn">
            Assigned on the job but not on this load: {waiting.map((person) => person.name).join(", ")}. Add them when they start, and their timer begins then.
          </Notice>
        </div>
      ) : null}

      {manage && !done ? (
        <div className="mt-4 grid gap-4 border-t border-black/5 pt-4 lg:grid-cols-2 lg:gap-6">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void onAct(`/tracking/unloading/${load.id}/crew`, {
                source,
                badge: source === "badge" ? badge : undefined,
                employeeId: source === "badge" ? undefined : employeeId,
              }).then((saved) => {
                if (saved) setBadge("");
              });
            }}
          >
            <h4 className="text-sm font-semibold">Add to crew</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="How they were recorded">
                <select className="field" value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
                  <option value="badge">Badge onto the load</option>
                  <option value="lead_added">Lead added the name</option>
                  <option value="paper">Paper crew list</option>
                </select>
              </Field>
              {source === "badge" ? (
                <Field label="Badge">
                  <input className="field font-mono" required autoComplete="off" value={badge} onChange={(event) => setBadge(event.target.value)} placeholder="Scan badge" />
                </Field>
              ) : (
                <Field label="Employee">
                  <select className="field" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
                    {[...people]
                      .sort((a, b) => Number(waiting.some((w) => w.employeeId === b.id)) - Number(waiting.some((w) => w.employeeId === a.id)))
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                          {waiting.some((w) => w.employeeId === person.id) ? " · assigned on the job" : ""}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </div>
            <button className="btn btn-sm" type="submit">
              Add to crew
            </button>
          </form>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!window.confirm(`Finish ${load.reference} with ${pallets} pallets and ${cartons} cartons? These counts can go on the bill.`)) return;
              void onAct(`/tracking/unloading/${load.id}/finish`, {
                palletCount: Number(pallets),
                cartonCount: Number(cartons),
              });
            }}
          >
            <h4 className="text-sm font-semibold">Finish unload</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Pallets">
                <input className="field" type="number" min={0} required value={pallets} onChange={(event) => setPallets(event.target.value)} />
              </Field>
              <Field label="Cartons">
                <input className="field" type="number" min={0} required value={cartons} onChange={(event) => setCartons(event.target.value)} />
              </Field>
            </div>
            <button className="btn btn-primary btn-sm" type="submit">
              Finish unload
            </button>
          </form>
        </div>
      ) : null}
    </article>
  );
}
