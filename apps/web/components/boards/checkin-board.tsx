"use client";

import { useState } from "react";
import { BadgeQr } from "@/components/badge-qr";
import { FloorDevicesPanel } from "@/components/floor-access";
import { Avatar, Badge, EmptyRow, isToday, MoreButton, Notice, PageTitle, Panel, SearchBox, Segmented, SkeletonList, Stat, StatGrid, usePaged, useResource } from "@/components/ui";
import { when } from "@/lib/api";

type Employee = {
  id: string;
  name: string;
  badgeCode: string;
  departmentHome: string;
  active: boolean;
  clientId: string | null;
};

type Tab = "visits" | "badges" | "setup";

type ShiftTime = {
  totalSeconds: number;
  taskSeconds: number;
  mealSeconds: number;
  pausedSeconds: number;
  pauses: { reason: string; seconds: number }[];
  unaccountedSeconds: number;
};

type Visit = {
  id: string;
  name: string;
  badgeCode: string;
  departmentHome: string;
  clockIn: string;
  clockOut: string | null;
  source: string;
  clientId: string | null;
  time: ShiftTime;
};

function hoursLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function how(source: string) {
  if (source === "manual") return "Added by a manager";
  if (source === "station") return "Check-in station";
  return source === "qr" ? "QR gate (old)" : "Floor phone (old)";
}

export function CheckInBoard({ client }: { client?: { id: string; name: string } }) {
  const people = useResource<Employee[]>("/tracking/employees");
  const board = useResource<{ visits: Visit[] }>("/tracking/checkins");
  const [tab, setTab] = useState<Tab>("visits");
  const [search, setSearch] = useState("");

  const visits = (board.data?.visits ?? []).filter((visit) => (client ? visit.clientId === client.id : !visit.clientId));
  const insideNow = visits.filter((visit) => !visit.clockOut).length;
  const todayVisits = visits.filter((visit) => isToday(visit.clockIn)).length;
  const unaccounted = visits.reduce((sum, visit) => sum + visit.time.unaccountedSeconds, 0);
  const badges = (people.data ?? []).filter((person) => person.active && (client ? person.clientId === client.id : !person.clientId));
  const query = search.trim().toLowerCase();
  const visibleVisits = visits.filter((visit) => !query || `${visit.name} ${visit.badgeCode}`.toLowerCase().includes(query));
  const visibleBadges = badges.filter((person) => !query || `${person.name} ${person.badgeCode}`.toLowerCase().includes(query));
  const pagedVisits = usePaged(visibleVisits);
  const tabs = [
    ["visits", "Shifts"],
    ["badges", "QR badges"],
    ...(client ? [] : ([["setup", "Station iPads"]] as const)),
  ] as readonly (readonly [Tab, string])[];

  return (
    <div>
      <PageTitle
        kicker="Check-in"
        title={client ? `Check-in for ${client.name}` : "Check-in and QR IDs"}
        detail="Who is on shift, how their time splits between tasks, pauses (with the reason given), meals, and unaccounted time, and their QR badges."
        actions={
          <a className="btn btn-primary" href="/station" target="_blank" rel="noreferrer">
            Open floor phone
          </a>
        }
      />
      {people.error ? <div className="mb-4"><Notice tone="bad">{people.error}</Notice></div> : null}
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <StatGrid>
        <Stat label="On shift now" value={insideNow} tone="ok" />
        <Stat label="Check-ins today" value={todayVisits} />
        <Stat label="Unaccounted today" value={hoursLabel(unaccounted)} tone={unaccounted >= 1800 ? "warn" : undefined} />
        <Stat label="People with badges" value={badges.length} />
      </StatGrid>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Check-in view" options={tabs} value={tab} onChange={setTab} />
        {tab === "visits" || tab === "badges" ? <SearchBox value={search} onChange={setSearch} label="Search people" placeholder="Search name or badge" /> : null}
      </div>

      {tab === "visits" ? (
        <Panel title="Shifts" count={visibleVisits.length}>
          {board.loading && !board.data ? <div className="p-4"><SkeletonList rows={3} /></div> : null}
          {board.data && visibleVisits.length === 0 ? <EmptyRow title={query ? "Nobody matches that search" : "No shifts yet"}>{query ? null : "Shifts appear here when people check in at the station."}</EmptyRow> : null}
          {visibleVisits.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-left text-sm">
                <thead className="bg-black/[0.03] text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium sm:px-5">Person</th>
                    <th className="px-4 py-2.5 font-medium">In</th>
                    <th className="px-4 py-2.5 font-medium">Out</th>
                    <th className="px-4 py-2.5 font-medium">Shift</th>
                    <th className="px-4 py-2.5 font-medium">On tasks</th>
                    <th className="px-4 py-2.5 font-medium">Paused</th>
                    <th className="px-4 py-2.5 font-medium">Meal</th>
                    <th className="px-4 py-2.5 font-medium sm:px-5">Unaccounted</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedVisits.shown.map((visit) => (
                    <tr key={visit.id} className="border-t border-black/5">
                      <td className="px-4 py-2.5 sm:px-5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={visit.name} active={!visit.clockOut} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{visit.name}</div>
                            <div className="font-mono text-xs text-muted">{visit.badgeCode}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div>{when(visit.clockIn)}</div>
                        <div className="text-xs text-muted">{how(visit.source)}</div>
                      </td>
                      <td className="px-4 py-2.5">{visit.clockOut ? when(visit.clockOut) : <Badge tone="ok" dot>On shift</Badge>}</td>
                      <td className="px-4 py-2.5 tabular-nums">{hoursLabel(visit.time.totalSeconds)}</td>
                      <td className="px-4 py-2.5 tabular-nums">{hoursLabel(visit.time.taskSeconds)}</td>
                      <td className="px-4 py-2.5">
                        <div className="tabular-nums">{hoursLabel(visit.time.pausedSeconds)}</div>
                        {visit.time.pauses.length > 0 ? (
                          <div className="max-w-[14rem] text-xs text-muted">
                            {visit.time.pauses.map((item) => `${item.reason} ${hoursLabel(item.seconds)}`).join(" · ")}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{hoursLabel(visit.time.mealSeconds)}</td>
                      <td className="px-4 py-2.5 tabular-nums sm:px-5">
                        <span className={visit.time.unaccountedSeconds >= 900 ? "font-semibold text-clay" : ""}>{hoursLabel(visit.time.unaccountedSeconds)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <MoreButton hidden={pagedVisits.hidden} onClick={pagedVisits.more} />
        </Panel>
      ) : null}

      {tab === "badges" ? (
        visibleBadges.length ? (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visibleBadges.map((person) => (
              <article key={person.id} className="card flex items-center gap-4 p-4">
                <BadgeQr badge={person.badgeCode} />
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{person.name}</h2>
                  <p className="truncate font-mono text-sm text-muted">{person.badgeCode}</p>
                  <p className="mt-1 text-sm capitalize text-muted">{person.departmentHome}</p>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <div className="card">
            <EmptyRow title={query ? "Nobody matches that search" : "No badges yet"}>{query ? null : "Add people to create their QR badges."}</EmptyRow>
          </div>
        )
      ) : null}

      {tab === "setup" && !client ? (
        <div className="space-y-4">
          <Notice tone="warn">
            To set up an iPad: open this page on it, sign in, approve it below, open the check-in station, then sign out on the iPad. Staff then only see the station.
          </Notice>
          <FloorDevicesPanel />
        </div>
      ) : null}
    </div>
  );
}
