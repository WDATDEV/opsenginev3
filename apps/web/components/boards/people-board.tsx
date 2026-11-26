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

function WorkChips({ offered, picked, onChange }: { offered: string[]; picked: string[]; onChange: (next: string[]) => void }) {
  return (
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
              onChange={() => onChange(on ? picked.filter((value) => value !== item) : [...picked, item])}
            />
            {LABELS[item] ?? item}
          </label>
        );
      })}
    </div>
  );
}

function EditPerson({
  person,
  offered,
  onCancel,
  onSaved,
}: {
  person: Employee;
  offered: string[];
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(person.name);
  const [badgeCode, setBadgeCode] = useState(person.badgeCode);
  const [picked, setPicked] = useState<string[]>(workOf(person));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep work they already have visible, even if the client turned that service off, so it can be removed.
  const choices = DEPARTMENTS.filter((item) => offered.includes(item) || workOf(person).includes(item));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (picked.length === 0) {
      setError("Choose at least one kind of work.");
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ message: string }>(`/tracking/employees/${person.id}`, {
        name,
        badgeCode,
        departments: DEPARTMENTS.filter((item) => picked.includes(item)),
      });
      onSaved(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that person.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="col-span-full mt-2 space-y-3 rounded-xl border border-black/10 bg-white p-3 sm:p-4" onSubmit={save}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input className="field" required autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Badge">
          <input className="field font-mono" required autoComplete="off" value={badgeCode} onChange={(event) => setBadgeCode(event.target.value)} />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink/80">Can do (choose one or more)</legend>
        <WorkChips offered={choices} picked={picked} onChange={setPicked} />
        <p className="mt-1.5 text-xs text-muted">Work they are doing right now keeps running. The new list applies from their next switch.</p>
      </fieldset>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
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
  const [editing, setEditing] = useState<string | null>(null);

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

  async function setStatus(person: Employee, active: boolean) {
    if (!active && !window.confirm(`Deactivate ${person.name}? Their badge stops working now, and any open shift ends.`)) return;
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ message: string }>(`/tracking/employees/${person.id}/status`, { active });
      setMessage(result.message);
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that person.");
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
                <WorkChips offered={offered} picked={picked} onChange={setPicked} />
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
              <li key={person.id} className={`grid grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:px-5 ${person.active ? "" : "bg-black/[0.025]"}`}>
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
                {manage ? (
                  <div className="col-start-2 flex gap-1 justify-self-start sm:col-start-4 sm:justify-self-end">
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      aria-expanded={editing === person.id}
                      onClick={() => setEditing(editing === person.id ? null : person.id)}
                    >
                      Edit
                    </button>
                    <button
                      className={`btn btn-ghost btn-sm ${person.active ? "btn-danger" : ""}`}
                      type="button"
                      onClick={() => void setStatus(person, !person.active)}
                    >
                      {person.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                ) : null}
                {manage && editing === person.id ? (
                  <EditPerson
                    key={person.id}
                    person={person}
                    offered={offered}
                    onCancel={() => setEditing(null)}
                    onSaved={(text) => {
                      setEditing(null);
                      setError(null);
                      setMessage(text);
                      board.reload();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <MoreButton hidden={paged.hidden} onClick={paged.more} />
        </Panel>
      </div>
    </div>
  );
}
