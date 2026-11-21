"use client";

import Link from "next/link";
import { useState } from "react";
import { BadgeQr } from "@/components/badge-qr";
import { useSession } from "@/components/shell";
import { Avatar, Badge, EmptyRow, Field, isToday, MoreButton, Notice, PageTitle, Panel, SearchBox, Segmented, SkeletonList, Stat, StatGrid, usePaged, useResource } from "@/components/ui";
import { api, ApiError, canManage, post, when } from "@/lib/api";

type Employee = {
  id: string;
  name: string;
  badgeCode: string;
  departmentHome: string;
  active: boolean;
  clientId: string | null;
};

type Site = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

type Refusal = { at: string; text: string };
type Tab = "visits" | "badges" | "refused" | "setup";

type Visit = {
  id: string;
  name: string;
  badgeCode: string;
  departmentHome: string;
  clockIn: string;
  clockOut: string | null;
  source: string;
  clientId: string | null;
  clockInPlace: string | null;
  clockInLat: number | null;
  clockInLng: number | null;
  clockOutPlace: string | null;
  clockOutLat: number | null;
  clockOutLng: number | null;
};

function spot(place: string | null, lat: number | null, lng: number | null) {
  const gps = lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null;
  if (!place && !gps) return "—";
  return [place, gps].filter(Boolean).join(" · ");
}

function how(source: string) {
  if (source === "manual") return "Added by a manager";
  return source === "qr" ? "QR gate" : "Earlier punch";
}

export function CheckInBoard({ client }: { client?: { id: string; name: string } }) {
  const user = useSession();
  const people = useResource<Employee[]>("/tracking/employees");
  const board = useResource<{ visits: Visit[]; refused: Refusal[] }>("/tracking/checkins");
  const fence = useResource<{ site: Site | null }>("/tracking/site");
  const gate = useResource<{ mode: "location" | "qr_gate"; places: { id: string; name: string }[] }>("/tracking/gate");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [newPlace, setNewPlace] = useState("");
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [radiusMeters, setRadiusMeters] = useState("250");
  const [siteMessage, setSiteMessage] = useState<string | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("visits");
  const [search, setSearch] = useState("");

  function useThisDevice() {
    setSiteError(null);
    if (!navigator.geolocation) {
      setSiteError("This device cannot share its location.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude.toFixed(6));
        setLongitude(position.coords.longitude.toFixed(6));
      },
      () => setSiteError("This device did not share its location."),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  async function chooseMode(mode: "location" | "qr_gate") {
    if (modeSaving || gate.data?.mode === mode) return;
    setModeSaving(true);
    setModeError(null);
    try {
      await post("/tracking/gate/mode", { mode });
      gate.reload();
    } catch (err) {
      setModeError(err instanceof ApiError ? err.message : "Could not change the check-in method.");
    } finally {
      setModeSaving(false);
    }
  }

  async function addPlace(event: React.FormEvent) {
    event.preventDefault();
    setPlaceError(null);
    try {
      await post("/tracking/gate/places", { name: newPlace });
      setNewPlace("");
      gate.reload();
    } catch (err) {
      setPlaceError(err instanceof ApiError ? err.message : "Could not add that gate location.");
    }
  }

  async function removePlace(id: string) {
    setPlaceError(null);
    try {
      await api(`/tracking/gate/places/${id}`, { method: "DELETE" });
      gate.reload();
    } catch (err) {
      setPlaceError(err instanceof ApiError ? err.message : "Could not remove that gate location.");
    }
  }

  async function saveSite(event: React.FormEvent) {
    event.preventDefault();
    setSiteError(null);
    setSiteMessage(null);
    try {
      await post("/tracking/site", {
        latitude: Number(latitude),
        longitude: Number(longitude),
        radiusMeters: Number(radiusMeters),
      });
      setSiteMessage("The warehouse check is on. Scans outside this area are refused.");
      fence.reload();
    } catch (err) {
      setSiteError(err instanceof ApiError ? err.message : "Could not save the warehouse location.");
    }
  }

  const manage = canManage(user?.role);
  const visits = (board.data?.visits ?? []).filter((visit) => (client ? visit.clientId === client.id : !visit.clientId));
  const insideNow = visits.filter((visit) => !visit.clockOut).length;
  const todayVisits = visits.filter((visit) => isToday(visit.clockIn)).length;
  const refused = board.data?.refused ?? [];
  const badges = (people.data ?? []).filter((person) => person.active && (client ? person.clientId === client.id : !person.clientId));
  const query = search.trim().toLowerCase();
  const visibleVisits = visits.filter((visit) => !query || `${visit.name} ${visit.badgeCode}`.toLowerCase().includes(query));
  const visibleBadges = badges.filter((person) => !query || `${person.name} ${person.badgeCode}`.toLowerCase().includes(query));
  const pagedVisits = usePaged(visibleVisits);
  const tabs = [
    ["visits", "Visits"],
    ["badges", "QR badges"],
    ["refused", refused.length ? `Refused (${refused.length})` : "Refused"],
    ...(client ? [] : ([["setup", "Setup"]] as const)),
  ] as readonly (readonly [Tab, string])[];
  const siteLine =
    gate.data?.mode === "qr_gate"
      ? "Not used while the QR gate option is on. It applies again if you switch back to Location."
      : fence.data?.site
        ? `On. The warehouse is marked, and a device must be within ${fence.data.site.radiusMeters} m.`
        : "Off until a supervisor marks where the warehouse is. The gate and the floor phone refuse people until then.";

  return (
    <div>
      <PageTitle
        kicker="Check-in"
        title={client ? `Check-in for ${client.name}` : "Check-in and QR IDs"}
        detail="See who is inside, show QR badges, and review refused scans."
        actions={
          <Link className="btn btn-primary" href="/gate">
            Open the QR gate
          </Link>
        }
      />
      {people.error ? <div className="mb-4"><Notice tone="bad">{people.error}</Notice></div> : null}
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <StatGrid>
        <Stat label="Inside now" value={insideNow} tone="ok" />
        <Stat label="Check-ins today" value={todayVisits} />
        <Stat label="People with badges" value={badges.length} />
        <Stat label="Refused scans" value={refused.length} tone={refused.length ? "warn" : undefined} />
      </StatGrid>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Check-in view" options={tabs} value={tab} onChange={setTab} />
        {tab === "visits" || tab === "badges" ? <SearchBox value={search} onChange={setSearch} label="Search people" placeholder="Search name or badge" /> : null}
      </div>

      {tab === "visits" ? (
        <Panel title="Visits" count={visibleVisits.length}>
          {board.loading && !board.data ? <div className="p-4"><SkeletonList rows={3} /></div> : null}
          {board.data && visibleVisits.length === 0 ? <EmptyRow title={query ? "Nobody matches that search" : "No visits yet"}>{query ? null : "Check-ins appear here as people arrive."}</EmptyRow> : null}
          {visibleVisits.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-left text-sm">
                <thead className="bg-black/[0.03] text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium sm:px-5">Person</th>
                    <th className="px-4 py-2.5 font-medium">In</th>
                    <th className="px-4 py-2.5 font-medium">Out</th>
                    <th className="px-4 py-2.5 font-medium sm:px-5">Through</th>
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
                        <div className="text-xs text-muted">{spot(visit.clockInPlace, visit.clockInLat, visit.clockInLng)}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        {visit.clockOut ? (
                          <>
                            <div>{when(visit.clockOut)}</div>
                            <div className="text-xs text-muted">{spot(visit.clockOutPlace, visit.clockOutLat, visit.clockOutLng)}</div>
                          </>
                        ) : (
                          <Badge tone="ok" dot>Still in</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 sm:px-5">{how(visit.source)}</td>
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

      {tab === "refused" ? (
        <Panel title="Refused scans" count={refused.length}>
          {refused.length === 0 ? <EmptyRow title="No refused scans">Scans the gate rejects will appear here.</EmptyRow> : null}
          <ul className="divide-y divide-black/5">
            {refused.map((item) => (
              <li key={`${item.at}-${item.text}`} className="px-4 py-3 sm:px-5">
                <p className="text-sm">{item.text}</p>
                <p className="mt-0.5 text-xs text-muted">{when(item.at)}</p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {tab === "setup" && !client ? (
        <div className="space-y-5">
          <section className="card space-y-4 p-4 sm:p-5">
            <div>
              <h2 className="font-semibold">How people check in</h2>
              <p className="mt-1 text-sm text-muted">Pick one. This decides what the QR gate and the floor phone check.</p>
            </div>
            {modeError ? <Notice tone="bad">{modeError}</Notice> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    id: "location",
                    title: "Location",
                    text: "The device must be at the warehouse. The floor phone checks its location and checks the person in. The QR gate checks it too.",
                  },
                  {
                    id: "qr_gate",
                    title: "QR gate",
                    text: "People check in at the QR gate. The floor phone only checks that the person is checked in. No device location is needed.",
                  },
                ] as const
              ).map((option) => {
                const active = (gate.data?.mode ?? "location") === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    disabled={!manage || modeSaving}
                    onClick={() => void chooseMode(option.id)}
                    className={`card p-4 text-left transition disabled:opacity-70 ${active ? "!border-moss ring-1 ring-moss" : "hover:bg-black/[0.02]"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{option.title}</span>
                      {active ? <Badge tone="ok" dot>On</Badge> : null}
                    </span>
                    <span className="mt-1 block text-sm text-muted">{option.text}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="card space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="font-semibold">Gate locations</h2>
              <p className="mt-1 text-sm text-muted">The spots a QR gate can sit at. The person scanning picks one, and it is saved with each check-in.</p>
            </div>
            {placeError ? <Notice tone="bad">{placeError}</Notice> : null}
            <ul className="flex flex-wrap gap-2">
              {(gate.data?.places ?? []).map((place) => (
                <li key={place.id} className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-surface py-1 pl-3 pr-1 text-sm">
                  {place.name}
                  {manage ? (
                    <button
                      type="button"
                      className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-black/5 hover:text-rust"
                      aria-label={`Remove ${place.name}`}
                      onClick={() => void removePlace(place.id)}
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {manage ? (
              <form className="flex gap-2" onSubmit={addPlace}>
                <input
                  className="field"
                  value={newPlace}
                  maxLength={40}
                  onChange={(event) => setNewPlace(event.target.value)}
                  placeholder="New gate location, for example Back door"
                  aria-label="New gate location"
                />
                <button className="btn btn-primary shrink-0" type="submit" disabled={newPlace.trim() === ""}>
                  Add
                </button>
              </form>
            ) : null}
          </section>
          <section className="card space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="font-semibold">Warehouse location check</h2>
              <p className="mt-1 text-sm text-muted">{siteLine}</p>
            </div>
            {siteMessage ? <Notice tone="ok">{siteMessage}</Notice> : null}
            {siteError ? <Notice tone="bad">{siteError}</Notice> : null}
            {manage ? (
              <form className="grid gap-3 md:grid-cols-[1fr_1fr_140px_auto]" onSubmit={saveSite}>
                <Field label="Latitude">
                  <input className="field font-mono" value={latitude} onChange={(event) => setLatitude(event.target.value)} required />
                </Field>
                <Field label="Longitude">
                  <input className="field font-mono" value={longitude} onChange={(event) => setLongitude(event.target.value)} required />
                </Field>
                <Field label="Radius, meters">
                  <input className="field font-mono" value={radiusMeters} onChange={(event) => setRadiusMeters(event.target.value)} required />
                </Field>
                <div className="flex items-end gap-2">
                  <button className="btn btn-ghost" type="button" onClick={useThisDevice}>
                    Use this device
                  </button>
                  <button className="btn btn-primary" type="submit">
                    Save
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
