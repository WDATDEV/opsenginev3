"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post } from "@/lib/api";

const DEPARTMENTS = ["packing", "picking", "receiving", "unloading", "sorting", "indirect"] as const;

type Activity = {
  id: string;
  code: string;
  name: string;
  department: string;
  billable: boolean;
};

export default function ActivitiesPage() {
  const activities = useResource<Activity[]>("/tracking/activities");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [department, setDepartment] = useState<(typeof DEPARTMENTS)[number]>("unloading");
  const [billable, setBillable] = useState(true);

  return (
    <div>
      <PageTitle
        kicker="Activities"
        title="Activity types for every client"
        detail="A warehouse manager adds an activity once. IceCartel and Jacob then price it on their own rate cards, and the floor can clock it."
      />
      {activities.error ? <Notice tone="bad">{activities.error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {canManage(user?.role) ? (
        <form
          className="card mb-6 grid gap-3 p-4 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setMessage(null);
            void post<{ message?: string }>("/tracking/activities", { code, name, department, billable })
              .then((result) => {
                setMessage(result.message ?? "Saved.");
                setCode("");
                setName("");
                setBillable(true);
                activities.reload();
              })
              .catch((err: unknown) => {
                setError(err instanceof ApiError ? err.message : "Could not add that activity.");
              });
          }}
        >
          <Field label="Code">
            <input className="field font-mono" value={code} onChange={(event) => setCode(event.target.value)} placeholder="wrap_pallets" />
          </Field>
          <Field label="Name">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Wrap pallets" />
          </Field>
          <Field label="Department">
            <select className="field" value={department} onChange={(event) => setDepartment(event.target.value as (typeof DEPARTMENTS)[number])}>
              {DEPARTMENTS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={billable} onChange={(event) => setBillable(event.target.checked)} />
              Billable
            </label>
            <button className="btn btn-primary" type="submit">
              Add activity
            </button>
          </div>
        </form>
      ) : null}
      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-black/10 text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Billing</th>
            </tr>
          </thead>
          <tbody>
            {activities.data?.map((activity) => (
              <tr key={activity.id} className="border-b border-black/5 last:border-0">
                <td className="px-4 py-3 font-medium">{activity.name}</td>
                <td className="px-4 py-3 font-mono text-muted">{activity.code}</td>
                <td className="px-4 py-3">{activity.department}</td>
                <td className="px-4 py-3">{activity.billable ? "Billable" : "Not billed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {activities.data?.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No activities yet.</p> : null}
      </div>
    </div>
  );
}
