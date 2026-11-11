"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, Field, Notice, PageTitle, SkeletonList, Spinner, useResource } from "@/components/ui";
import { api, ApiError, APP_SECTIONS, hasSection, post, type User } from "@/lib/api";

type Account = User & { createdAt: string };
type Client = { id: string; name: string };

const ROLES: { id: User["role"]; label: string }[] = [
  { id: "warehouse_manager", label: "Warehouse manager" },
  { id: "hr_finance", label: "HR / Finance" },
  { id: "client_services", label: "Client services" },
  { id: "warehouse_employee", label: "Warehouse employee" },
  { id: "external_customer", label: "External customer" },
];

function roleLabel(role: string) {
  return ROLES.find((item) => item.id === role)?.label ?? role;
}

export default function UsersPage() {
  const user = useSession();
  const allowed = hasSection(user, "users");
  const list = useResource<Account[]>(allowed ? "/users" : null);
  const clients = useResource<Client[]>(allowed ? "/clients" : null);
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!user) return <SkeletonList rows={3} />;
  if (!allowed) return <Notice tone="bad">Users is for people who have been given that section.</Notice>;

  return (
    <div>
      <PageTitle
        kicker="Management"
        title="Users"
        detail="Add people who sign in on the management side. Choose which sections they may open. The API checks the same list on every request."
        actions={
          <button className="btn btn-primary" type="button" onClick={() => setEditing("new")}>
            Add user
          </button>
        }
      />
      {error ? <div className="mb-4"><Notice tone="bad">{error}</Notice></div> : null}
      {notice ? <div className="mb-4"><Notice tone="ok">{notice}</Notice></div> : null}
      {editing ? (
        <Editor
          initial={editing === "new" ? null : editing}
          clients={clients.data ?? []}
          actor={user}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice("Saved.");
            setError(null);
            list.reload();
          }}
          onError={setError}
        />
      ) : null}
      {list.loading && !list.data ? <SkeletonList rows={4} /> : null}
      {list.error ? <Notice tone="bad">{list.error}</Notice> : null}
      {list.data && list.data.length === 0 ? <EmptyState title="No users yet">Add someone and turn on the sections they need.</EmptyState> : null}
      <ul className="max-w-3xl space-y-2">
        {(list.data ?? []).map((account) => (
          <li key={account.id} className="card flex flex-wrap items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{account.name}</p>
              <p className="text-sm text-muted">{account.email}</p>
              <p className="mt-1 text-sm text-muted">{roleLabel(account.role)}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {account.sections.map((section) => (
                  <Badge key={section}>{APP_SECTIONS.find(([id]) => id === section)?.[1] ?? section}</Badge>
                ))}
              </div>
            </div>
            {account.role === "owner" ? (
              <p className="text-xs text-muted">Owner — all sections</p>
            ) : (
              <div className="flex gap-2">
                <button className="btn btn-sm" type="button" onClick={() => setEditing(account)}>
                  Edit
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => {
                    if (!window.confirm(`Remove ${account.name}? They will not be able to sign in.`)) return;
                    api(`/users/${account.id}`, { method: "DELETE" })
                      .then(() => {
                        setNotice("Removed.");
                        list.reload();
                      })
                      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not remove that user."));
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Editor({
  initial,
  clients,
  actor,
  onClose,
  onSaved,
  onError,
}: {
  initial: Account | null;
  clients: Client[];
  actor: User;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<User["role"]>(initial?.role ?? "warehouse_manager");
  const [sections, setSections] = useState<string[]>(initial?.sections?.length ? initial.sections : ["time", "mail"]);
  const [clientIds, setClientIds] = useState<string[]>(initial?.clientIds ?? []);
  const [busy, setBusy] = useState(false);
  const needsClients = role === "external_customer" || role === "client_services";
  const ownerActor = actor.role === "owner";

  function toggle(section: string) {
    setSections((list) => (list.includes(section) ? list.filter((item) => item !== section) : [...list, section]));
  }

  async function save() {
    setBusy(true);
    onError("");
    try {
      const body = {
        name,
        email,
        password: password || undefined,
        role,
        sections,
        clientIds: needsClients ? clientIds : null,
      };
      if (initial) await api(`/users/${initial.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await post("/users", body);
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save that user.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card mb-5 max-w-3xl space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="font-semibold">{initial ? "Edit user" : "New user"}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </Field>
        <Field label="Email">
          <input className="field" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={200} />
        </Field>
      </div>
      <Field label={initial ? "New password (optional)" : "Password"} hint={initial ? "Leave blank to keep the current password." : "At least 8 characters."}>
        <input className="field max-w-sm" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={initial ? undefined : 8} required={!initial} />
      </Field>
      <Field label="Role">
        <select className="field max-w-sm" value={role} onChange={(event) => setRole(event.target.value)}>
          {ROLES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink/80">Sections they may open</legend>
        <div className="space-y-2">
          {APP_SECTIONS.map(([id, label]) => {
            const locked = !ownerActor && (id === "users" || id === "settings");
            return (
              <label key={id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sections.includes(id)} disabled={locked} onChange={() => toggle(id)} />
                {label}
                {id === "settings" ? <span className="text-xs text-muted">Connectors and API keys</span> : null}
              </label>
            );
          })}
        </div>
      </fieldset>
      {needsClients ? (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink/80">Clients they may see</legend>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {clients.map((client) => (
              <label key={client.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={clientIds.includes(client.id)}
                  onChange={() =>
                    setClientIds((list) => (list.includes(client.id) ? list.filter((id) => id !== client.id) : [...list, client.id]))
                  }
                />
                {client.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="flex gap-2">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? <Spinner /> : "Save"}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
