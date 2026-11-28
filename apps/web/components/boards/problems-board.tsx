"use client";

// Problems to follow up: discrepancies, damage, missorts, system exceptions, and suspected employee errors.
// Each one has an owner, a status, notes with photos, a root cause, and a corrective action with a due date.

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Field, Flash, Notice, PageTitle, Panel, Segmented, SkeletonList, timeAgo, useResource } from "@/components/ui";
import { ApiError, canManage, post } from "@/lib/api";
import { shrinkPhoto } from "@/lib/photo";

export const CASE_KINDS = [
  ["receiving_discrepancy", "Receiving discrepancy"],
  ["damage", "Damage"],
  ["missort", "Missort"],
  ["inventory_discrepancy", "Inventory discrepancy"],
  ["employee_error", "Employee error"],
  ["system_exception", "System exception"],
  ["other", "Other"],
] as const;

const KIND_LABEL: Record<string, string> = Object.fromEntries(CASE_KINDS);
const STATUS_LABEL: Record<string, string> = { open: "Open", investigating: "Investigating", resolved: "Resolved", closed: "Closed" };
const STATUS_TONE: Record<string, "bad" | "warn" | "ok" | "neutral"> = { open: "bad", investigating: "warn", resolved: "ok", closed: "neutral" };

type CaseSummary = {
  id: string;
  kind: string;
  status: string;
  title: string;
  details: string | null;
  clientName: string | null;
  jobReference: string | null;
  employeeName: string | null;
  errorConfirmed: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  reportedBy: string;
  trackingNumber: string | null;
  orderNumber: string | null;
  sku: string | null;
  rootCause: string | null;
  correctiveAction: string | null;
  correctiveDueOn: string | null;
  correctiveDoneAt: string | null;
  createdAt: string;
  notes?: number;
  photos?: number;
};

type CaseDetail = CaseSummary & { notes: { id: string; authorName: string; text: string | null; photo: string | null; system: boolean; createdAt: string }[] };
type Owner = { id: string; name: string; role: string };
type Filter = "active" | "resolved" | "closed" | "all";

export function ProblemsBoard() {
  const user = useSession();
  const manage = canManage(user?.role);
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>("active");
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(Boolean(params.get("new")));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams();
  if (filter !== "all") query.set("status", filter);
  if (kind) query.set("kind", kind);
  const board = useResource<{ counts: Record<string, number>; cases: CaseSummary[] }>(`/work/cases?${query.toString()}`);
  const owners = useResource<Owner[]>("/work/cases/owners");
  const counts = board.data?.counts ?? {};
  const active = (counts.open ?? 0) + (counts.investigating ?? 0);

  function saved(text: string) {
    setError(null);
    setMessage(text);
    board.reload();
  }

  return (
    <div>
      <PageTitle
        kicker="Operations"
        title="Problems"
        detail="Discrepancies, damage, missorts and errors to follow up. A suspected employee error stays separate from system exceptions until a manager confirms it."
        actions={
          manage ? (
            <button className="btn btn-primary" type="button" onClick={() => setAdding(!adding)} aria-expanded={adding}>
              {adding ? "Close" : "Record a problem"}
            </button>
          ) : null
        }
      />
      <Flash message={message} error={error} />
      {manage && adding ? (
        <NewProblem
          owners={owners.data ?? []}
          onSaved={(text) => {
            setAdding(false);
            saved(text);
          }}
          onError={setError}
        />
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          label="Which problems"
          value={filter}
          onChange={setFilter}
          options={[
            ["active", `Open (${active})`],
            ["resolved", `Resolved (${counts.resolved ?? 0})`],
            ["closed", `Closed (${counts.closed ?? 0})`],
            ["all", "All"],
          ]}
        />
        <select className="field !min-h-[2.25rem] !w-auto !py-1.5 text-sm" value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Kind of problem">
          <option value="">Every kind</option>
          {CASE_KINDS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <Panel title="Problems" count={board.data?.cases.length}>
        {board.error ? <div className="p-4"><Notice tone="bad">{board.error}</Notice></div> : null}
        {board.loading && !board.data ? <div className="p-4"><SkeletonList rows={4} /></div> : null}
        {board.data && board.data.cases.length === 0 ? <EmptyRow title="Nothing here">Problems reported from the floor or recorded here show up in this list.</EmptyRow> : null}
        <ul className="divide-y divide-black/5">
          {(board.data?.cases ?? []).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`flex w-full flex-wrap items-start justify-between gap-3 px-4 py-3 text-left hover:bg-black/[0.02] sm:px-5 ${open === item.id ? "bg-black/[0.02]" : ""}`}
                aria-expanded={open === item.id}
                onClick={() => setOpen(open === item.id ? null : item.id)}
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[item.status]} dot>
                      {STATUS_LABEL[item.status] ?? item.status}
                    </Badge>
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted">{KIND_LABEL[item.kind] ?? item.kind}</span>
                    {item.kind === "employee_error" ? <Badge tone={item.errorConfirmed ? "bad" : "neutral"}>{item.errorConfirmed ? "Confirmed error" : "Suspected"}</Badge> : null}
                  </p>
                  <p className="mt-1 break-words font-medium">{item.title}</p>
                  <p className="text-sm text-muted">
                    {[item.clientName, item.jobReference, item.employeeName, item.trackingNumber, item.orderNumber, item.sku].filter(Boolean).join(" · ") || "No client"}
                  </p>
                </div>
                <div className="text-right text-sm text-muted">
                  <p>{item.ownerName ? `Owner: ${item.ownerName}` : "No owner"}</p>
                  <p>
                    {item.reportedBy} · {timeAgo(item.createdAt).toLowerCase()}
                  </p>
                  {item.correctiveDueOn && !item.correctiveDoneAt ? <p className="font-medium text-clay">Action due {item.correctiveDueOn}</p> : null}
                </div>
              </button>
              {open === item.id ? (
                <div className="border-t border-black/5 bg-black/[0.015] px-4 py-4 sm:px-5">
                  <ProblemDetail id={item.id} manage={manage} owners={owners.data ?? []} onSaved={saved} onError={setError} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function PhotoInput({ onPhoto, onError }: { onPhoto: (data: string | null) => void; onError: (message: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="btn btn-ghost btn-sm cursor-pointer">
        {busy ? "Preparing…" : preview ? "Change photo" : "Add a photo"}
        <input
          className="sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true);
            shrinkPhoto(file)
              .then((data) => {
                setPreview(data);
                onPhoto(data);
              })
              .catch((err: unknown) => onError(err instanceof Error ? err.message : "Could not read that photo."))
              .finally(() => setBusy(false));
          }}
        />
      </label>
      {preview ? (
        <>
          {/* A data URL preview: the Next image optimizer does not apply. */}
          <img src={preview} alt="Photo to attach" className="h-16 w-16 rounded-lg object-cover" />
          <button
            className="text-sm text-muted underline"
            type="button"
            onClick={() => {
              setPreview(null);
              onPhoto(null);
            }}
          >
            Remove
          </button>
        </>
      ) : null}
    </div>
  );
}

function NewProblem({ owners, onSaved, onError }: { owners: Owner[]; onSaved: (message: string) => void; onError: (message: string) => void }) {
  const params = useSearchParams();
  const people = useResource<{ id: string; name: string; badgeCode: string; active: boolean }[]>("/tracking/employees");
  const clients = useResource<{ id: string; name: string }[]>("/clients");
  const [kind, setKind] = useState(params.get("kind") ?? "damage");
  const [title, setTitle] = useState(params.get("title") ?? "");
  const [details, setDetails] = useState("");
  const [clientId, setClientId] = useState(params.get("clientId") ?? "");
  const [employeeId, setEmployeeId] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [trackingNumber, setTrackingNumber] = useState(params.get("trackingNumber") ?? "");
  const [orderNumber, setOrderNumber] = useState(params.get("orderNumber") ?? "");
  const [sku, setSku] = useState(params.get("sku") ?? "");
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = { jobId: params.get("jobId"), shipmentId: params.get("shipmentId"), loadId: params.get("loadId"), gaylordId: params.get("gaylordId") };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries(
        Object.entries({
          kind,
          title,
          details,
          clientId,
          employeeId: kind === "employee_error" ? employeeId : "",
          ownerUserId,
          trackingNumber,
          orderNumber,
          sku,
          photo: photo ?? "",
          ...linked,
        }).filter(([, value]) => value),
      );
      const result = await post<{ message: string }>("/work/cases", body);
      onSaved(result.message);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not record that problem.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card mb-5 space-y-3 p-4 sm:p-5" onSubmit={save}>
      <h2 className="font-semibold">Record a problem</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <select className="field" value={kind} onChange={(event) => setKind(event.target.value)}>
            {CASE_KINDS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input className="field" required minLength={3} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What went wrong, in a few words" />
        </Field>
        {kind === "employee_error" ? (
          <Field label="Who it is about" hint="Stays “suspected” until a manager confirms it.">
            <select className="field" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">Choose a person</option>
              {(people.data ?? [])
                .filter((person) => person.active)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name} ({person.badgeCode})
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        <Field label="Client">
          <select className="field" value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={Boolean(linked.jobId)}>
            <option value="">{linked.jobId ? "From the job" : "No client"}</option>
            {(clients.data ?? []).map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owner">
          <select className="field" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>
            <option value="">Nobody yet</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tracking number">
          <input className="field font-mono" maxLength={60} value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} />
        </Field>
        <Field label="Order number">
          <input className="field" maxLength={60} value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} />
        </Field>
        <Field label="SKU">
          <input className="field" maxLength={80} value={sku} onChange={(event) => setSku(event.target.value)} />
        </Field>
      </div>
      <Field label="What happened">
        <textarea className="field min-h-24" maxLength={2000} value={details} onChange={(event) => setDetails(event.target.value)} />
      </Field>
      <PhotoInput onPhoto={setPhoto} onError={onError} />
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save problem"}
      </button>
    </form>
  );
}

function ProblemDetail({
  id,
  manage,
  owners,
  onSaved,
  onError,
}: {
  id: string;
  manage: boolean;
  owners: Owner[];
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const detail = useResource<CaseDetail>(`/work/cases/${id}`);
  const [rootCause, setRootCause] = useState("");
  const [action, setAction] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoKey, setPhotoKey] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!detail.data) return;
    setRootCause(detail.data.rootCause ?? "");
    setAction(detail.data.correctiveAction ?? "");
    setDueOn(detail.data.correctiveDueOn ?? "");
  }, [detail.data]);

  async function change(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await post<{ message: string }>(`/work/cases/${id}`, body);
      onSaved(result.message);
      detail.reload();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  async function addNote(event: React.FormEvent) {
    event.preventDefault();
    if (!note.trim() && !photo) return;
    setBusy(true);
    try {
      await post(`/work/cases/${id}/notes`, { ...(note.trim() ? { text: note.trim() } : {}), ...(photo ? { photo } : {}) });
      setNote("");
      setPhoto(null);
      setPhotoKey((key) => key + 1);
      detail.reload();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not add that note.");
    } finally {
      setBusy(false);
    }
  }

  if (detail.error) return <Notice tone="bad">{detail.error}</Notice>;
  if (!detail.data) return <SkeletonList rows={3} />;
  const item = detail.data;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-3">
        <ol className="space-y-2">
          {item.notes.map((entry) => (
            <li key={entry.id} className={`rounded-lg px-3 py-2 text-sm ${entry.system ? "bg-black/[0.03] text-muted" : "bg-white"}`}>
              <p className="text-xs text-muted">
                <span className="font-medium text-ink">{entry.authorName}</span> · {timeAgo(entry.createdAt).toLowerCase()}
              </p>
              {entry.text ? <p className="mt-0.5 whitespace-pre-wrap break-words">{entry.text}</p> : null}
              {entry.photo ? (
                <a href={entry.photo} target="_blank" rel="noreferrer" className="mt-1.5 inline-block">
                  <img src={entry.photo} alt="Photo from this problem" className="max-h-56 rounded-lg" />
                </a>
              ) : null}
            </li>
          ))}
        </ol>
        <form className="space-y-2" onSubmit={addNote}>
          <textarea className="field min-h-20" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note" aria-label="Add a note" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PhotoInput key={photoKey} onPhoto={setPhoto} onError={onError} />
            <button className="btn btn-ghost btn-sm" type="submit" disabled={busy || (!note.trim() && !photo)}>
              Add note
            </button>
          </div>
        </form>
      </div>

      <div className="space-y-3 text-sm">
        {manage ? (
          <>
            <Field label="Status">
              <select className="field" value={item.status} disabled={busy} onChange={(event) => void change({ status: event.target.value })}>
                {Object.entries(STATUS_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Owner">
              <select className="field" value={item.ownerUserId ?? ""} disabled={busy} onChange={(event) => void change({ ownerUserId: event.target.value || null })}>
                <option value="">Nobody</option>
                {owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.name}
                  </option>
                ))}
              </select>
            </Field>
            {item.kind === "employee_error" ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={item.errorConfirmed} disabled={busy} onChange={(event) => void change({ errorConfirmed: event.target.checked })} />
                Confirmed employee error {item.employeeName ? `(${item.employeeName})` : ""}
              </label>
            ) : null}
            <Field label="Root cause">
              <textarea className="field min-h-16" maxLength={2000} value={rootCause} onChange={(event) => setRootCause(event.target.value)} />
            </Field>
            <Field label="Corrective action">
              <textarea className="field min-h-16" maxLength={2000} value={action} onChange={(event) => setAction(event.target.value)} />
            </Field>
            <Field label="Action due">
              <input className="field" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary btn-sm"
                type="button"
                disabled={busy}
                onClick={() => void change({ rootCause: rootCause || null, correctiveAction: action || null, correctiveDueOn: dueOn || null })}
              >
                Save
              </button>
              {item.correctiveAction ? (
                <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void change({ correctiveDone: !item.correctiveDoneAt })}>
                  {item.correctiveDoneAt ? "Action not done" : "Action done"}
                </button>
              ) : null}
            </div>
            {item.correctiveDoneAt ? <p className="text-moss">Corrective action done {timeAgo(item.correctiveDoneAt).toLowerCase()}.</p> : null}
          </>
        ) : (
          <dl className="space-y-1">
            <dt className="text-muted">Root cause</dt>
            <dd>{item.rootCause ?? "Not set"}</dd>
            <dt className="text-muted">Corrective action</dt>
            <dd>{item.correctiveAction ?? "Not set"}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}
