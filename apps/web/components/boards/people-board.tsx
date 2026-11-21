"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Avatar, EmptyRow, Field, Flash, MoreButton, Notice, PageTitle, Panel, SearchBox, SkeletonList, usePaged, useResource } from "@/components/ui";
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
  const manage = canManage(user?.role);
  const [name, setName] = useState("");
  const [badgeCode, setBadgeCode] = useState("");
  const offered = client?.enabledServices
    ? DEPARTMENTS.filter((item) => client.enabledServices?.includes(item))
    : DEPARTMENTS;
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
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

  const people = (board.data ?? []).filter((person) => (client ? person.clientId === client.id : !person.clientId));
  const query = search.trim().toLowerCase();
  const list = people.filter((person) => !query || `${person.name} ${person.badgeCode} ${workOf(person).join(" ")}`.toLowerCase().includes(query));
  const paged = usePaged(list);

  return (
    <div>
      <PageTitle
        kicker="People"
        title={client ? `People for ${client.name}` : "Badges"}
        detail={client ? `Everyone who works for ${client.name}, their badge, and the work they may do.` : "Everyone on the floor, their badge, and the work they may do."}
      />
      {board.error ? <div className="mb-4"><Notice tone="bad">{board.error}</Notice></div> : null}
      <Flash message={message} error={error} />
      <div className={`grid items-start gap-5 ${manage ? "lg:grid-cols-[21rem_minmax(0,1fr)]" : ""}`}>
        {manage ? (
          <form className="card space-y-3 p-4 sm:p-5 lg:sticky lg:top-6" onSubmit={submit}>
            <h2 className="font-semibold">Add someone</h2>
            <Field label="Name">
              <input className="field" required autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Badge">
              <input className="field font-mono" required autoComplete="off" value={badgeCode} onChange={(event) => setBadgeCode(event.target.value)} />
            </Field>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink/80">Can do (choose one or more)</legend>
              {offered.length === 0 ? (
                <p className="text-sm text-muted">Turn on a work service for this client first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {offered.map((item) => {
                    const on = picked.includes(item);
                    return (
                      <label
                        key={item}
                        className={`inline-flex min-h-10 cursor-pointer select-none items-center justify-center rounded-full border px-3.5 text-sm font-medium capitalize leading-none transition-colors focus-within:ring-2 focus-within:ring-moss/40 ${
                          on ? "border-moss bg-moss text-paper" : "border-black/15 bg-white text-ink hover:border-moss"
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
        <Panel title="People" count={list.length} actions={<SearchBox value={search} onChange={setSearch} label="Search people" placeholder="Search name, badge, work" />}>
          {board.loading && !board.data ? <div className="p-4"><SkeletonList rows={3} /></div> : null}
          {board.data && list.length === 0 ? <EmptyRow title={query ? "Nobody matches that search" : "Nobody added yet"}>{query ? null : "Add someone with a badge to get started."}</EmptyRow> : null}
          <ul className="divide-y divide-black/5">
            {paged.shown.map((person) => (
              <li key={person.id} className={`grid grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.4fr)] sm:px-5 ${person.active ? "" : "opacity-60"}`}>
                <Avatar name={person.name} active={person.active} />
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {person.name}
                    {person.active ? "" : " (inactive)"}
                  </p>
                  <p className="truncate font-mono text-xs text-muted">{person.badgeCode}</p>
                </div>
                <div className="col-start-2 flex flex-wrap gap-1 sm:col-start-3">
                  {workOf(person).map((item) => (
                    <span key={item} className="badge capitalize">
                      {LABELS[item] ?? item}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <MoreButton hidden={paged.hidden} onClick={paged.more} />
        </Panel>
      </div>
    </div>
  );
}
