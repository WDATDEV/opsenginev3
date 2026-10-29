"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post } from "@/lib/api";

type Employee = {
  id: string;
  name: string;
  badgeCode: string;
  departmentHome: string;
  employmentType: string;
  warehanceUserId: string | null;
  active: boolean;
};

const DEPARTMENTS = ["packing", "picking", "receiving", "unloading", "sorting", "indirect"];

export default function PeoplePage() {
  const board = useResource<Employee[]>("/tracking/employees");
  const user = useSession();
  const [name, setName] = useState("");
  const [badgeCode, setBadgeCode] = useState("");
  const [departmentHome, setDepartmentHome] = useState("packing");
  const [warehanceUserId, setWarehanceUserId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await post("/tracking/employees", {
        name,
        badgeCode,
        departmentHome,
        employmentType: "employee",
        warehanceUserId: warehanceUserId || undefined,
      });
      setMessage(`${name} is on the floor.`);
      setName("");
      setBadgeCode("");
      setWarehanceUserId("");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that person.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="People"
        title="Badges and Warehance users"
        detail="A badge is how the floor knows a person. A Warehance user is optional, because some packers share a station login and some pickers only have a scanner."
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {canManage(user?.role) ? (
          <form className="card space-y-3 p-4" onSubmit={submit}>
            <h2 className="font-semibold">Add someone</h2>
            {message ? <Notice tone="ok">{message}</Notice> : null}
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Name">
              <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Badge">
              <input className="field font-mono" value={badgeCode} onChange={(event) => setBadgeCode(event.target.value)} />
            </Field>
            <Field label="Home department">
              <select className="field" value={departmentHome} onChange={(event) => setDepartmentHome(event.target.value)}>
                {DEPARTMENTS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Warehance user, if they have one">
              <input className="field font-mono" value={warehanceUserId} onChange={(event) => setWarehanceUserId(event.target.value)} />
            </Field>
            <button className="btn btn-primary w-full" type="submit">
              Add employee
            </button>
          </form>
        ) : null}
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-black/[0.03] text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Badge</th>
                <th className="px-4 py-3 font-medium">Home</th>
                <th className="px-4 py-3 font-medium">Warehance</th>
              </tr>
            </thead>
            <tbody>
              {board.data?.map((person) => (
                <tr key={person.id} className="border-t border-black/5">
                  <td className="px-4 py-3 font-medium">{person.name}</td>
                  <td className="px-4 py-3 font-mono">{person.badgeCode}</td>
                  <td className="px-4 py-3 capitalize">{person.departmentHome}</td>
                  <td className="px-4 py-3 font-mono text-xs">{person.warehanceUserId ?? "Shared or none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
