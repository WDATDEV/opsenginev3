"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, initials, Notice, PageTitle, Spinner, timeAgo, useResource } from "@/components/ui";
import { when } from "@/lib/api";

type Person = {
  id: string;
  name: string;
  badgeCode: string;
  departmentHome: string;
  clockedIn: boolean;
  onMeal: boolean;
  shiftStartedAt: string | null;
  entry: string | null;
  entryPlace: string | null;
  place: string | null;
  paused: { reason: string | null; since: string; title: string } | null;
  lastTask: { title: string; endedAt: string; ended: string | null } | null;
  task: { title?: string; department: string; startedAt: string; jobReference?: string | null; clientName?: string | null } | null;
};

// A shift this long is almost always a missed check-out.
const LONG_SHIFT_MS = 14 * 60 * 60 * 1000;

const ENDED: Record<string, string> = {
  complete: "Finished",
  switch: "Stopped",
  meal: "Stopped for meal",
  clock_out: "Stopped",
};

type Floor = {
  counts: Record<string, number>;
  totals: {
    packed: number;
    picks: number;
    openShipments: number;
    openLoads: number;
    openGaylords: number;
  };
  people: Person[];
  feed: { at: string; text: string }[];
  policy: { id: string; area: string; question: string; answer: string }[];
};

type Status = "working" | "paused" | "idle" | "meal" | "off";
type View = "here" | Status;

const REFRESH_MS = 20_000;
const FEED_PREVIEW = 8;
const DEPARTMENTS = ["packing", "picking", "receiving", "unloading", "sorting"] as const;
const STATUS_ORDER: Record<Status, number> = { working: 0, paused: 1, idle: 2, meal: 3, off: 4 };
const STATUS_META: Record<Status, { label: string; tone: "ok" | "warn" | "neutral" }> = {
  working: { label: "Working", tone: "ok" },
  paused: { label: "Paused", tone: "warn" },
  idle: { label: "Between tasks", tone: "warn" },
  meal: { label: "On meal", tone: "neutral" },
  off: { label: "Off shift", tone: "neutral" },
};
const VIEW_TITLES: Record<View, string> = {
  here: "On shift now",
  working: "Working now",
  paused: "Paused",
  idle: "Between tasks",
  meal: "On meal",
  off: "Off shift",
};

function statusOf(person: Person): Status {
  if (person.onMeal) return "meal";
  if (person.task) return "working";
  if (!person.clockedIn) return "off";
  return person.paused ? "paused" : "idle";
}

function capitalize(text: string) {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function elapsed(from: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));
  if (minutes < 1) return "Under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

function matches(person: Person, query: string) {
  const text = [person.name, person.badgeCode, person.task?.clientName, person.task?.jobReference, person.task?.department, person.departmentHome]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes(query);
}

export function FloorBoard() {
  const user = useSession();
  const { data, error, loading, reload } = useResource<Floor>(user ? "/tracking/floor" : null);
  const [view, setView] = useState<View>("here");
  const [department, setDepartment] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [allFeed, setAllFeed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    if (data) setUpdatedAt(new Date().toISOString());
  }, [data]);

  // The board stays live, but does not load data while the tab is in the background.
  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      if (!document.hidden) reload();
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [user, reload]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const people = data?.people;
  const tally = useMemo(() => {
    const counts: Record<Status, number> = { working: 0, paused: 0, idle: 0, meal: 0, off: 0 };
    for (const person of people ?? []) counts[statusOf(person)] += 1;
    return counts;
  }, [people]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const list = (people ?? []).filter((person) => {
      // A search looks across everyone, so an off-shift person can still be found.
      if (query) return matches(person, query);
      const status = statusOf(person);
      if (view === "here" ? status === "off" : status !== view) return false;
      return !department || person.task?.department === department;
    });
    return [...list].sort((a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] || a.name.localeCompare(b.name));
  }, [people, query, view, department]);

  function chooseView(next: View) {
    setView(next);
    setDepartment(null);
    setSearch("");
  }

  function chooseDepartment(next: string) {
    const clearing = department === next;
    setDepartment(clearing ? null : next);
    setView(clearing ? "here" : "working");
    setSearch("");
  }

  const onShift = tally.working + tally.paused + tally.idle + tally.meal;
  const listTitle = query ? "Search results" : department ? `${capitalize(department)} now` : VIEW_TITLES[view];
  const filtered = Boolean(query || department || view !== "here");
  const departments = data && (data.counts.indirect ?? 0) > 0 ? [...DEPARTMENTS, "indirect"] : [...DEPARTMENTS];
  const busiest = Math.max(1, ...departments.map((key) => data?.counts[key] ?? 0));
  const feed = data ? (allFeed ? data.feed : data.feed.slice(0, FEED_PREVIEW)) : [];

  return (
    <div>
      <PageTitle
        kicker="Live floor"
        title="Who is doing what"
        detail="See who is on shift, where they are working, and what just happened."
        actions={
          data ? (
            <>
              <span className="inline-flex items-center gap-2 text-sm text-muted" role="status">
                <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
                  {error ? null : <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-moss opacity-40" />}
                  <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${error ? "bg-clay" : "bg-moss"}`} />
                </span>
                {error ? "Not updating" : `Live${updatedAt ? ` · updated ${timeAgo(updatedAt).toLowerCase()}` : ""}`}
              </span>
              <button className="btn btn-sm" type="button" onClick={reload} disabled={loading}>
                {loading ? <Spinner /> : "Refresh"}
              </button>
            </>
          ) : null
        }
      />

      {error ? (
        <div className="mb-4">
          <Notice tone="bad">{data ? `Could not refresh the floor. Showing the last update. ${error}` : error}</Notice>
        </div>
      ) : null}

      {!data && !error ? <FloorSkeleton /> : null}

      {data ? (
        <div className="page-enter space-y-5">
          <section aria-label="Shift summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile label="On shift" value={onShift} note={`of ${data.people.length} people`} active={view === "here" && !department && !query} onClick={() => chooseView("here")} />
            <StatTile label="Working" value={tally.working} note="on a task" tone="ok" active={view === "working" && !department && !query} onClick={() => chooseView("working")} />
            <StatTile label="Paused" value={tally.paused} note="gave a reason" tone={tally.paused ? "warn" : undefined} active={view === "paused" && !query} onClick={() => chooseView("paused")} />
            <StatTile label="Between tasks" value={tally.idle} note={tally.idle ? "may need work" : "nobody waiting"} tone={tally.idle ? "warn" : undefined} active={view === "idle" && !query} onClick={() => chooseView("idle")} />
            <StatTile label="On meal" value={tally.meal} note="on break" active={view === "meal" && !query} onClick={() => chooseView("meal")} />
            <StatTile label="Off shift" value={tally.off} note="not clocked in" active={view === "off" && !query} onClick={() => chooseView("off")} />
          </section>

          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0 space-y-5">
              <section className="card p-4 sm:p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-semibold">People by department</h2>
                  <p className="text-xs text-muted">Select one to filter</p>
                </div>
                <ul className="mt-3 grid gap-x-8 gap-y-0.5 md:grid-cols-2">
                  {departments.map((key) => {
                    const count = data.counts[key] ?? 0;
                    const active = department === key;
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          aria-pressed={active}
                          title={`${count} ${count === 1 ? "person" : "people"} on ${key} now`}
                          onClick={() => chooseDepartment(key)}
                          className={`grid w-full grid-cols-[6rem_1fr_2rem] items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                            active ? "bg-moss/10 font-semibold" : "hover:bg-black/[0.04]"
                          }`}
                        >
                          <span>{capitalize(key)}</span>
                          <span className="h-2 overflow-hidden rounded-full bg-black/[0.06]" aria-hidden="true">
                            <span className="block h-full rounded-full bg-moss transition-[width] duration-300" style={{ width: `${(count / busiest) * 100}%` }} />
                          </span>
                          <span className="text-right font-mono tabular-nums">{count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/10 px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold">{listTitle}</h2>
                    <Badge>{visible.length}</Badge>
                    {filtered ? (
                      <button className="text-sm font-medium text-moss hover:underline" type="button" onClick={() => chooseView("here")}>
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <input
                    className="field !min-h-[2.25rem] !py-1.5 text-sm sm:!w-64"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search name, badge, client, job"
                    aria-label="Search people on the floor"
                  />
                </div>
                {visible.length ? (
                  <ul className="divide-y divide-black/5">
                    {visible.map((person) => (
                      <PersonRow key={person.id} person={person} now={now} />
                    ))}
                  </ul>
                ) : (
                  <div className="px-6 py-10 text-center">
                    <p className="font-medium">{query ? "Nobody matches that search" : emptyTitle(view, department)}</p>
                    <p className="mt-1 text-sm text-muted">
                      {query ? "Try a name, badge, client, or job." : "People appear here as soon as they clock in or start a task."}
                    </p>
                  </div>
                )}
              </section>
            </div>

            <aside className="min-w-0 space-y-5">
              <section className="card p-4 sm:p-5">
                <h2 className="font-semibold">Open work</h2>
                <dl className="mt-3 grid grid-cols-3 gap-2">
                  <Mini label="Shipments" value={data.totals.openShipments} />
                  <Mini label="Loads" value={data.totals.openLoads} />
                  <Mini label="Carrier bins" value={data.totals.openGaylords} />
                </dl>
                <dl className="mt-4 space-y-1.5 border-t border-black/5 pt-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Orders packed, all time</dt>
                    <dd className="font-mono tabular-nums">{data.totals.packed.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Pick lines, all time</dt>
                    <dd className="font-mono tabular-nums">{data.totals.picks.toLocaleString()}</dd>
                  </div>
                </dl>
              </section>

              <section className="card p-4 sm:p-5">
                <h2 className="font-semibold">Latest work</h2>
                {feed.length ? (
                  <ol className="mt-3 space-y-3">
                    {feed.map((item, index) => (
                      <li key={`${item.at}-${index}`} className="relative border-l border-black/10 pb-0.5 pl-4">
                        <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full bg-moss ring-2 ring-surface" aria-hidden="true" />
                        <p className="text-sm leading-5">{item.text}</p>
                        <time className="mt-0.5 block text-xs text-muted" dateTime={item.at} title={when(item.at)}>
                          {timeAgo(item.at)}
                        </time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-sm text-muted">Nothing has been recorded yet.</p>
                )}
                {data.feed.length > FEED_PREVIEW ? (
                  <button className="btn btn-ghost btn-sm mt-4 w-full" type="button" onClick={() => setAllFeed((open) => !open)}>
                    {allFeed ? "Show less" : `Show all ${data.feed.length}`}
                  </button>
                ) : null}
              </section>
            </aside>
          </div>

          {data.policy.length ? (
            <details className="card group overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 font-semibold sm:px-5 [&::-webkit-details-marker]:hidden">
                How this floor is recorded
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 flex-none text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 8 5 5 5-5" />
                </svg>
              </summary>
              <div className="grid gap-x-8 gap-y-5 border-t border-black/5 px-4 py-4 sm:px-5 md:grid-cols-2">
                {data.policy.map((rule) => (
                  <article key={rule.id}>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss">{rule.area}</p>
                    <h3 className="mt-1 text-sm font-medium">{rule.question}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted">{rule.answer}</p>
                  </article>
                ))}
              </div>
            </details>
          ) : null}

          {data.people.length === 0 ? <EmptyState title="No people yet">Add people with badges to see them on the floor.</EmptyState> : null}
        </div>
      ) : null}
    </div>
  );
}

function emptyTitle(view: View, department: string | null) {
  if (department) return `Nobody is on ${department} right now`;
  if (view === "here") return "Nobody is on shift right now";
  if (view === "working") return "Nobody is working a task right now";
  if (view === "paused") return "Nobody is paused right now";
  if (view === "idle") return "Nobody is waiting between tasks";
  if (view === "meal") return "Nobody is on a meal break";
  return "Everyone is on shift";
}

function StatTile({
  label,
  value,
  note,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  note: string;
  tone?: "ok" | "warn";
  active: boolean;
  onClick: () => void;
}) {
  const dot = tone === "ok" ? "bg-moss" : tone === "warn" ? "bg-clay" : "bg-black/25";
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`card card-hover p-4 text-left ${active ? "!border-moss ring-1 ring-moss" : ""}`}
    >
      <span className="flex items-center gap-2 text-sm text-muted">
        <span className={`h-2 w-2 flex-none rounded-full ${dot}`} aria-hidden="true" />
        {label}
      </span>
      <span className="mt-1 block font-mono text-3xl font-medium tabular-nums">{value}</span>
      <span className="block text-xs text-muted">{note}</span>
    </button>
  );
}

function PersonRow({ person, now }: { person: Person; now: number }) {
  const status = statusOf(person);
  const meta = STATUS_META[status];
  const task = person.task;
  const where = [task?.clientName, task?.jobReference].filter(Boolean).join(" · ");
  const headline =
    status === "meal"
      ? "On a meal break"
      : task
        ? task.title ?? capitalize(task.department)
        : status === "paused" && person.paused
          ? `Paused: ${person.paused.reason ?? "no reason given"}`
          : status === "idle"
            ? person.lastTask
              ? `${ENDED[person.lastTask.ended ?? ""] ?? "Stopped"} ${person.lastTask.title} ${timeAgo(person.lastTask.endedAt).toLowerCase()}`
              : "Checked in, no task yet"
            : `Home: ${capitalize(person.departmentHome)}`;
  const context =
    status === "working"
      ? [capitalize(task?.department ?? ""), where || "Not on a client job"].filter(Boolean).join(" · ")
      : status === "paused" && person.paused
        ? `On ${person.paused.title}`
        : status === "off"
          ? null
          : `Home: ${capitalize(person.departmentHome)}`;
  const longShift = Boolean(person.shiftStartedAt && now - new Date(person.shiftStartedAt).getTime() > LONG_SHIFT_MS);
  const sinceShift = status !== "off" && person.shiftStartedAt ? `On shift since ${when(person.shiftStartedAt)}` : null;
  const extras = [person.place, sinceShift].filter(Boolean).join(" · ");
  // Paused and idle time are shown running, like the working timer.
  const runningSince = status === "working" ? task?.startedAt : status === "paused" ? person.paused?.since : status === "idle" ? person.lastTask?.endedAt ?? person.shiftStartedAt : null;

  return (
    <li className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1.3fr)_8rem] sm:px-5 ${status === "off" ? "text-ink/70" : ""}`}>
      <span className={`grid h-10 w-10 place-items-center rounded-full text-sm font-semibold ${status === "working" ? "bg-moss/15 text-moss" : "bg-black/[0.06] text-muted"}`} aria-hidden="true">
        {initials(person.name)}
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium">{person.name}</p>
        <p className="truncate font-mono text-xs text-muted">{person.badgeCode}</p>
      </div>
      <div className="col-span-2 col-start-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1">
        <p className="truncate text-sm font-medium">{headline}</p>
        {context || extras ? <p className="truncate text-xs text-muted">{[context, extras].filter(Boolean).join(" · ")}</p> : null}
        {longShift ? <p className="text-xs font-medium text-clay">On shift over 14 hours. They may have forgotten to check out.</p> : null}
      </div>
      <div className="col-start-3 row-start-1 flex flex-col items-end gap-0.5 sm:col-start-4">
        <Badge tone={meta.tone} dot>
          {meta.label}
        </Badge>
        {runningSince ? <span className="text-xs tabular-nums text-muted" title={`Since ${when(runningSince)}`}>{elapsed(runningSince, now)}</span> : null}
      </div>
    </li>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-black/[0.03] px-2.5 py-2">
      <dd className="font-mono text-xl tabular-nums">{value}</dd>
      <dt className="mt-0.5 text-[11px] leading-4 text-muted">{label}</dt>
    </div>
  );
}

function FloorSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading the floor">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="skeleton h-28" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="skeleton h-96" />
        <div className="skeleton h-96" />
      </div>
    </div>
  );
}
