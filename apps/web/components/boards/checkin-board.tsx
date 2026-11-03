"use client";

import Link from "next/link";
import { useState } from "react";
import { BadgeQr } from "@/components/badge-qr";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
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

  return (
    <div>
      <PageTitle
        kicker="Check-in"
        title={client ? `Check-in for ${client.name}` : "QR IDs"}
        detail={
          client
            ? `Badges and visits here belong to ${client.name}. A scan still has to come from a device at the warehouse.`
            : "Each person has a QR ID. Every scan must come from a device at the warehouse. A missing, vague, or far-away location is refused."
        }
      />
      {client ? null : (
      <>
      <section className="card mb-6 space-y-4 p-4">
        <div>
          <h2 className="font-semibold">How people check in</h2>
          <p className="mt-1 text-sm text-muted">
            Pick one. This decides what the QR gate and the floor phone check.
          </p>
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
                disabled={!canManage(user?.role) || modeSaving}
                onClick={() => void chooseMode(option.id)}
                className={`card p-4 text-left transition disabled:opacity-70 ${
                  active ? "border-moss ring-2 ring-moss/30" : "hover:bg-black/[0.02]"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{option.title}</span>
                  {active ? <span className="badge">On</span> : null}
                </span>
                <span className="mt-1 block text-sm text-muted">{option.text}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="card mb-6 space-y-3 p-4">
        <div>
          <h2 className="font-semibold">Gate locations</h2>
          <p className="mt-1 text-sm text-muted">
            The spots a QR gate can sit at. The person scanning picks one, and it is saved with each check-in.
          </p>
        </div>
        {placeError ? <Notice tone="bad">{placeError}</Notice> : null}
        <ul className="flex flex-wrap gap-2">
          {(gate.data?.places ?? []).map((place) => (
            <li key={place.id} className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-surface py-1 pl-3 pr-1 text-sm">
              {place.name}
              {canManage(user?.role) ? (
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
        {canManage(user?.role) ? (
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
      <section className="card mb-6 space-y-3 p-4">
        <h2 className="font-semibold">Warehouse location check</h2>
        <p className="text-sm text-muted">
          {gate.data?.mode === "qr_gate"
            ? "Not used while the QR gate option is on. It applies again if you switch back to Location."
            : fence.data?.site
              ? `On. The warehouse is marked, and a device must be within ${fence.data.site.radiusMeters} m.`
              : "Off until a supervisor marks where the warehouse is. The gate and the floor phone refuse people until then."}
        </p>
        {siteMessage ? <Notice tone="ok">{siteMessage}</Notice> : null}
        {siteError ? <Notice tone="bad">{siteError}</Notice> : null}
        {canManage(user?.role) ? (
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
      </>
      )}
      <p className="mb-6">
        <Link className="btn btn-primary" href="/gate">
          Open the QR gate
        </Link>
      </p>
      {people.error ? <Notice tone="bad">{people.error}</Notice> : null}
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      {board.data?.refused.length ? (
        <section className="card mb-6 p-4">
          <h2 className="font-semibold">Refused scans</h2>
          <ul className="mt-3 space-y-3">
            {board.data.refused.map((item) => (
              <li key={`${item.at}-${item.text}`} className="border-b border-black/5 pb-3 last:border-0">
                <p>{item.text}</p>
                <p className="mt-1 text-xs text-muted">{when(item.at)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-black/[0.03] text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Person</th>
              <th className="px-4 py-3 font-medium">In</th>
              <th className="px-4 py-3 font-medium">Out</th>
              <th className="px-4 py-3 font-medium">Through</th>
            </tr>
          </thead>
          <tbody>
            {board.data?.visits
              .filter((visit) => (client ? visit.clientId === client.id : !visit.clientId))
              .map((visit) => (
              <tr key={visit.id} className="border-t border-black/5">
                <td className="px-4 py-3">
                  <div className="font-medium">{visit.name}</div>
                  <div className="font-mono text-xs text-muted">{visit.badgeCode}</div>
                </td>
                <td className="px-4 py-3">
                  <div>{when(visit.clockIn)}</div>
                  <div className="text-xs text-muted">{spot(visit.clockInPlace, visit.clockInLat, visit.clockInLng)}</div>
                </td>
                <td className="px-4 py-3">
                  <div>{visit.clockOut ? when(visit.clockOut) : "Still in"}</div>
                  {visit.clockOut ? (
                    <div className="text-xs text-muted">
                      {spot(visit.clockOutPlace, visit.clockOutLat, visit.clockOutLng)}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3">{how(visit.source)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {people.data
          ?.filter((person) => person.active && (client ? person.clientId === client.id : !person.clientId))
          .map((person) => (
            <article key={person.id} className="card flex items-center gap-4 p-4">
              <BadgeQr badge={person.badgeCode} />
              <div>
                <h2 className="text-lg font-semibold">{person.name}</h2>
                <p className="font-mono text-sm text-muted">{person.badgeCode}</p>
                <p className="mt-1 text-sm capitalize text-muted">{person.departmentHome}</p>
              </div>
            </article>
          ))}
      </section>
    </div>
  );
}
