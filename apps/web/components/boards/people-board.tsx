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
  departments?: string[] | null;
  employmentType: string;
  active: boolean;
  clientId: string | null;
};

const DEPARTMENTS = ["packing", "picking", "receiving", "unloading", "sorting", "indirect"];
const LABELS: Record<string, string> = { indirect: "Internal work" };

function workOf(person: Employee) {
  return person.departments?.length ? person.departments : [person.departmentHome];
}

export function PeopleBoard({ client }: { client?: { id: string; name: string; enabledServices?: string[] } }) {
  const board = useResource<Employee[]>("/tracking/employees");
  const user = useSession();
  const [name, setName] = useState("");
  const [badgeCode, setBadgeCode] = useState("");
  const offered = client?.enabledServices
    ? DEPARTMENTS.filter((item) => client.enabledServices?.includes(item))
    : DEPARTMENTS;
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (picked.length === 0) {
      setError("Choose at least one kind of work.");
      return;
    }
    try {
      await post("/tracking/employees", {
        name,
        badgeCode,
        departments: picked,
        employmentType: "employee",
        ...(client ? { clientId: client.id } : {}),
      });
      setMessage(`${name} is on the floor.`);
      setName("");
      setBadgeCode("");
      setPicked([]);
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that person.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="People"
        title={client ? `People for ${client.name}` : "Badges"}
        detail={
          client
            ? `People added here belong to ${client.name}. Their badge is how check-in knows them.`
            : "A badge is how the floor knows a person. Packers on a shared station badge in. Pickers use a scanner."
        }
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
            <fieldset>
              <legend className="mb-1 text-sm text-muted">Can do (choose one or more)</legend>
              {offered.length === 0 ? (
                <p className="text-sm text-muted">Turn on a work service for this client first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {offered.map((item) => {
                    const on = picked.includes(item);
                    return (
                      <label
                        key={item}
                        className={`tap cursor-pointer rounded-full border px-4 py-2 text-sm capitalize ${
                          on ? "border-moss bg-moss text-paper" : "border-black/10 bg-white"
                        }`}
                      >
                        <input
                          className="sr-only"
                          type="checkbox"
                          checked={on}
                          onChange={() => setPicked(on ? picked.filter((value) => value !== item) : [...picked, item])}
                        />
                        {LABELS[item] ?? item}
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
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
                <th className="px-4 py-3 font-medium">Can do</th>
              </tr>
            </thead>
            <tbody>
              {board.data
                ?.filter((person) => (client ? person.clientId === client.id : !person.clientId))
                .map((person) => (
                <tr key={person.id} className="border-t border-black/5">
                  <td className="px-4 py-3 font-medium">{person.name}</td>
                  <td className="px-4 py-3 font-mono">{person.badgeCode}</td>
                  <td className="px-4 py-3 capitalize">{workOf(person).map((item) => LABELS[item] ?? item).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
