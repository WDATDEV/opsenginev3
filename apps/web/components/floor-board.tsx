"use client";

import { useSession } from "@/components/shell";
import { Notice, PageTitle, useResource } from "@/components/ui";
import { when } from "@/lib/api";

type Floor = {
  counts: Record<string, number>;
  totals: {
    packed: number;
    picks: number;
    openShipments: number;
    openLoads: number;
    openGaylords: number;
  };
  people: {
    id: string;
    name: string;
    badgeCode: string;
    departmentHome: string;
    warehanceUserId: string | null;
    clockedIn: boolean;
    onMeal: boolean;
    entry: string | null;
    entryPlace: string | null;
    place: string | null;
    task: { department: string; startedAt: string; jobReference?: string | null; clientName?: string | null } | null;
  }[];
  feed: { at: string; text: string }[];
  policy: { id: string; area: string; question: string; answer: string }[];
};

const COUNT_LABELS = ["packing", "picking", "receiving", "unloading", "sorting"] as const;

export function FloorBoard() {
  const user = useSession();
  const { data, error, loading } = useResource<Floor>(user ? "/tracking/floor" : null);

  return (
    <div>
      <PageTitle
        kicker="Live floor"
        title="Who is doing what"
        detail="Every pack, pick, receipt, unload, and gaylord scan is tied to a person, a device, and the task they were on."
      />
      {!user || (loading && !data) ? <p className="text-muted">Loading the floor…</p> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {data ? (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {COUNT_LABELS.map((key) => (
              <article key={key} className="card p-4">
                <p className="text-sm capitalize text-muted">{key}</p>
                <p className="mt-1 font-mono text-3xl">{data.counts[key] ?? 0}</p>
                <p className="text-xs text-muted">on this task now</p>
              </article>
            ))}
          </section>
          <section className="grid gap-3 sm:grid-cols-4">
            <Mini label="Orders packed" value={data.totals.packed} />
            <Mini label="Pick lines" value={data.totals.picks} />
            <Mini label="Open shipments" value={data.totals.openShipments} />
            <Mini label="Open gaylords" value={data.totals.openGaylords} />
          </section>
          <section className="card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-black/[0.03] text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Person</th>
                  <th className="px-4 py-3 font-medium">Home</th>
                  <th className="px-4 py-3 font-medium">Right now</th>
                  <th className="px-4 py-3 font-medium">Place</th>
                  <th className="px-4 py-3 font-medium">Warehance</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((person) => (
                  <tr key={person.id} className="border-t border-black/5">
                    <td className="px-4 py-3">
                      <div className="font-medium">{person.name}</div>
                      <div className="font-mono text-xs text-muted">{person.badgeCode}</div>
                    </td>
                    <td className="px-4 py-3 capitalize">{person.departmentHome}</td>
                    <td className="px-4 py-3">
                      {person.onMeal
                        ? "On meal"
                        : person.task
                          ? `${person.task.clientName ? `${person.task.clientName} ` : ""}${person.task.jobReference ? `${person.task.jobReference} · ` : ""}${person.task.department} since ${when(person.task.startedAt)}`
                          : person.clockedIn
                            ? person.entry === "qr"
                              ? `Checked in at ${person.entryPlace ?? "the QR gate"}`
                              : "Clocked in, between tasks"
                            : "Off shift"}
                      {person.entryPlace && person.task ? (
                        <div className="text-xs text-muted">In at {person.entryPlace}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono">{person.place ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {person.warehanceUserId ?? "No personal login"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="card p-4">
              <h2 className="text-lg font-semibold">Latest work</h2>
              <ul className="mt-3 space-y-3">
                {data.feed.map((item, index) => (
                  <li key={`${item.at}-${index}`} className="border-b border-black/5 pb-3 last:border-0">
                    <p>{item.text}</p>
                    <p className="mt-1 text-xs text-muted">{when(item.at)}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">How this floor is recorded</h2>
              {data.policy.map((rule) => (
                <article key={rule.id} className="card p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss">{rule.area}</p>
                  <h3 className="mt-1 font-medium">{rule.question}</h3>
                  <p className="mt-2 text-sm text-muted">{rule.answer}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <article className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="font-mono text-2xl">{value}</p>
    </article>
  );
}
