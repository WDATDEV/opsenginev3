"use client";

import Link from "next/link";
import { useState } from "react";
import { BadgeQr } from "@/components/badge-qr";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post, when } from "@/lib/api";

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
      <section className="card mb-6 space-y-3 p-4">
        <h2 className="font-semibold">Warehouse location check</h2>
        <p className="text-sm text-muted">
          {fence.data?.site
            ? `On. The warehouse is marked, and a device must be within ${fence.data.site.radiusMeters} m.`
            : "Off until a supervisor marks where the warehouse is. The gate refuses scans until then."}
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
