"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, Field, Notice, PageTitle, SkeletonList, Spinner, useResource } from "@/components/ui";
import { api, ApiError, post } from "@/lib/api";

type Audience = { everyone: boolean; groups: string[]; clientIds: string[]; contactIds: string[] };
type Category = "holiday" | "notice" | "other";

type Campaign = {
  id: string;
  title: string;
  category: Category;
  subject: string;
  body: string;
  audience: Audience;
  status: "draft" | "scheduled" | "sending" | "sent" | "failed";
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  note: string | null;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  pending: number;
};

type Contact = {
  id: string;
  email: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  groups: string[];
  doNotEmail: boolean;
};

type Options = { clients: { id: string; name: string }[]; groups: string[] };
type Template = { id: string; name: string; category: Category; subject: string; body: string };
type Settings = {
  senderName: string;
  replyTo: string;
  signature: string;
  dailyLimit: number;
  perMinute: number;
  gmailAccount: string | null;
};
type Recipient = { id: string; email: string; name: string; status: string; error: string | null; sentAt: string | null };

const CATEGORY: Record<Category, string> = { holiday: "Holiday", notice: "Important notice", other: "Other" };
const PLACEHOLDER = /\[[A-Z][A-Z0-9 ,.'/&-]{2,}\]/;
const emptyAudience: Audience = { everyone: false, groups: [], clientIds: [], contactIds: [] };

function stamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function toggle(list: string[], item: string) {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

function statusBadge(campaign: Campaign) {
  if (campaign.status === "sent") return <Badge tone="ok" dot>Sent</Badge>;
  if (campaign.status === "sending") return <Badge tone="warn" dot>Sending</Badge>;
  if (campaign.status === "scheduled") return <Badge tone="warn" dot>Scheduled</Badge>;
  if (campaign.status === "failed") return <Badge tone="bad" dot>Not finished</Badge>;
  return <Badge dot>Draft</Badge>;
}

export default function BulkEmailPage() {
  const user = useSession();
  const allowed = user?.role === "owner" || user?.role === "warehouse_manager";
  const [tab, setTab] = useState<"campaigns" | "contacts" | "settings">("campaigns");
  const campaigns = useResource<Campaign[]>(allowed ? "/mail/bulk/campaigns" : null);
  const contacts = useResource<Contact[]>(allowed ? "/mail/bulk/contacts" : null);
  const options = useResource<Options>(allowed ? "/mail/bulk/options" : null);
  const settings = useResource<Settings>(allowed ? "/mail/bulk/settings" : null);
  const templates = useResource<Template[]>(allowed ? "/mail/bulk/templates" : null);

  // A running campaign changes by itself, so keep the list fresh while one is going out.
  const busy = (campaigns.data ?? []).some((item) => item.status === "sending" || item.status === "scheduled");
  const reloadCampaigns = campaigns.reload;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(reloadCampaigns, 15_000);
    return () => clearInterval(timer);
  }, [busy, reloadCampaigns]);

  if (!allowed) {
    return <Notice tone="bad">Bulk email is for the warehouse manager.</Notice>;
  }

  return (
    <div>
      <PageTitle
        kicker="Mail"
        title="Bulk email"
        detail="Send holiday closures and important notices to the people you choose, now or at a set time. Everyone gets their own copy, so nobody sees the other addresses."
      />
      {settings.data && !settings.data.gmailAccount ? (
        <div className="mb-4">
          <Notice tone="warn">Gmail is not connected, so nothing can be sent. The owner can connect it in Settings.</Notice>
        </div>
      ) : null}
      <div className="mb-5 flex gap-1 rounded-xl bg-black/[0.04] p-1 text-sm font-medium" role="tablist">
        {(
          [
            ["campaigns", "Campaigns"],
            ["contacts", `Contacts${contacts.data ? ` · ${contacts.data.length}` : ""}`],
            ["settings", "Settings and templates"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg px-3 py-2 transition ${tab === id ? "bg-surface shadow-sm" : "text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "campaigns" ? (
        <CampaignsTab
          campaigns={campaigns}
          contacts={contacts.data ?? []}
          options={options.data ?? { clients: [], groups: [] }}
          templates={templates.data ?? []}
          gmailReady={Boolean(settings.data?.gmailAccount)}
          goContacts={() => setTab("contacts")}
        />
      ) : null}
      {tab === "contacts" ? (
        <ContactsTab
          contacts={contacts}
          options={options.data ?? { clients: [], groups: [] }}
          onChanged={() => {
            contacts.reload();
            options.reload();
          }}
        />
      ) : null}
      {tab === "settings" ? <SettingsTab settings={settings} templates={templates} /> : null}
    </div>
  );
}

// ---- Campaigns ----

function CampaignsTab({
  campaigns,
  contacts,
  options,
  templates,
  gmailReady,
  goContacts,
}: {
  campaigns: ReturnType<typeof useResource<Campaign[]>>;
  contacts: Contact[];
  options: Options;
  templates: Template[];
  gmailReady: boolean;
  goContacts: () => void;
}) {
  const [editing, setEditing] = useState<Campaign | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(path: string, body: unknown, done: string) {
    setProblem(null);
    setNotice(null);
    try {
      await post(path, body);
      setNotice(done);
      campaigns.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That did not work.");
    }
  }

  if (editing) {
    return (
      <Composer
        initial={editing === "new" ? null : editing}
        contacts={contacts}
        options={options}
        templates={templates}
        gmailReady={gmailReady}
        onClose={(message) => {
          setEditing(null);
          if (message) setNotice(message);
          campaigns.reload();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Holiday notices, closures and important updates, kept with who got them.</p>
        <button className="btn btn-primary" type="button" onClick={() => setEditing("new")}>
          New campaign
        </button>
      </div>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {campaigns.error ? <Notice tone="bad">{campaigns.error}</Notice> : null}
      {campaigns.loading && !campaigns.data ? <SkeletonList rows={3} /> : null}
      {campaigns.data && campaigns.data.length === 0 ? (
        <EmptyState
          title="No bulk emails yet"
          action={
            <div className="flex gap-2">
              <button className="btn btn-primary" type="button" onClick={() => setEditing("new")}>
                Write the first one
              </button>
              {contacts.length === 0 ? (
                <button className="btn btn-ghost" type="button" onClick={goContacts}>
                  Add contacts first
                </button>
              ) : null}
            </div>
          }
        >
          Pick a template such as a holiday closure, choose who gets it, and send it now or schedule it.
        </EmptyState>
      ) : null}
      {(campaigns.data ?? []).map((campaign) => (
        <article key={campaign.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted">
                {CATEGORY[campaign.category]}
                {statusBadge(campaign)}
              </p>
              <h2 className="mt-1 text-lg font-semibold">{campaign.title}</h2>
              <p className="text-sm text-muted">{campaign.subject}</p>
              <p className="mt-1 text-sm">
                {campaign.status === "draft" ? `Would reach ${campaign.total} ${campaign.total === 1 ? "person" : "people"}` : null}
                {campaign.status === "scheduled" && campaign.scheduledAt
                  ? `Goes out ${stamp(campaign.scheduledAt)} to ${campaign.total} ${campaign.total === 1 ? "person" : "people"}`
                  : null}
                {campaign.status === "sending" ? `${campaign.sent} of ${campaign.total} sent${campaign.failed ? ` · ${campaign.failed} failed` : ""}` : null}
                {campaign.status === "sent" || campaign.status === "failed"
                  ? `${campaign.sent} sent${campaign.failed ? ` · ${campaign.failed} failed` : ""}${campaign.pending ? ` · ${campaign.pending} not sent` : ""}${
                      campaign.finishedAt ? ` · ${stamp(campaign.finishedAt)}` : ""
                    }`
                  : null}
              </p>
              {campaign.note ? <p className="mt-1 text-sm text-clay">{campaign.note}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {campaign.status === "draft" ? (
                <>
                  <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditing(campaign)}>
                    Edit and send
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    type="button"
                    onClick={() => {
                      if (!window.confirm(`Delete the draft "${campaign.title}"?`)) return;
                      setProblem(null);
                      api(`/mail/bulk/campaigns/${campaign.id}`, { method: "DELETE" })
                        .then(() => campaigns.reload())
                        .catch((err: unknown) => setProblem(err instanceof ApiError ? err.message : "Could not delete it."));
                    }}
                  >
                    Delete
                  </button>
                </>
              ) : null}
              {campaign.status === "scheduled" ? (
                <button
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => void act(`/mail/bulk/campaigns/${campaign.id}/unschedule`, {}, "Taken off the schedule. It is a draft again.")}
                >
                  Cancel the schedule
                </button>
              ) : null}
              {campaign.status === "sending" ? (
                <button
                  className="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => {
                    if (window.confirm("Stop sending? People already emailed stay emailed, and the rest will not get it.")) {
                      void act(`/mail/bulk/campaigns/${campaign.id}/stop`, {}, "Stopped.");
                    }
                  }}
                >
                  Stop
                </button>
              ) : null}
              {campaign.status !== "draft" ? (
                <button className="btn btn-sm btn-ghost" type="button" onClick={() => setOpen(open === campaign.id ? null : campaign.id)}>
                  {open === campaign.id ? "Hide details" : "Details"}
                </button>
              ) : null}
            </div>
          </div>
          {open === campaign.id ? <Details campaign={campaign} /> : null}
        </article>
      ))}
    </div>
  );
}

function Details({ campaign }: { campaign: Campaign }) {
  const recipients = useResource<Recipient[]>(`/mail/bulk/campaigns/${campaign.id}/recipients`);
  return (
    <div className="mt-4 space-y-3 border-t border-black/5 pt-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Message</p>
        <pre className="mt-1 whitespace-pre-wrap rounded-xl bg-black/[0.03] p-3 font-sans text-sm">{campaign.body}</pre>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Who</p>
        {recipients.loading ? <Spinner /> : null}
        {recipients.data && recipients.data.length === 0 ? <p className="text-sm text-muted">The list is written when sending starts.</p> : null}
        <ul className="mt-1 max-h-72 divide-y divide-black/5 overflow-auto rounded-xl border border-black/5 text-sm">
          {(recipients.data ?? []).map((person) => (
            <li key={person.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{person.name || person.email}</span>
                {person.name ? <span className="ml-2 text-muted">{person.email}</span> : null}
                {person.error ? <span className="block text-xs text-rust">{person.error}</span> : null}
              </span>
              <Badge tone={person.status === "sent" ? "ok" : person.status === "failed" ? "bad" : "neutral"}>
                {person.status === "sent" ? "Sent" : person.status === "failed" ? "Failed" : "Waiting"}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Composer({
  initial,
  contacts,
  options,
  templates,
  gmailReady,
  onClose,
}: {
  initial: Campaign | null;
  contacts: Contact[];
  options: Options;
  templates: Template[];
  gmailReady: boolean;
  onClose: (message?: string) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "notice");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [audience, setAudience] = useState<Audience>(initial?.audience ?? emptyAudience);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState<null | "save" | "send" | "test">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ count: number; skipped: number; sample: string[] } | null>(null);

  const audienceKey = JSON.stringify(audience);
  useEffect(() => {
    const timer = setTimeout(() => {
      post<{ count: number; skipped: number; sample: string[] }>("/mail/bulk/preview", { audience: JSON.parse(audienceKey) as Audience })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [audienceKey]);

  const unfilled = PLACEHOLDER.test(subject) || PLACEHOLDER.test(body);
  const nobody = audience.everyone ? false : audience.groups.length + audience.clientIds.length + audience.contactIds.length === 0;
  const payload = { title: title || subject, category, subject, body, audience };

  function useTemplate(id: string) {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    setSubject(template.subject);
    setBody(template.body);
    setCategory(template.category);
    if (!title) setTitle(template.name);
  }

  async function save(): Promise<string | null> {
    if (initial) {
      await api(`/mail/bulk/campaigns/${initial.id}`, { method: "PUT", body: JSON.stringify(payload) });
      return initial.id;
    }
    const created = await post<{ id: string }>("/mail/bulk/campaigns", payload);
    return created.id;
  }

  async function submit(mode: "draft" | "send") {
    setProblem(null);
    setBusy(mode === "draft" ? "save" : "send");
    try {
      const id = await save();
      if (mode === "draft" || !id) {
        onClose("Draft saved.");
        return;
      }
      if (when === "later" && !at) throw new ApiError(400, "Choose when it should go out.");
      const result = await post<{ message: string }>(`/mail/bulk/campaigns/${id}/schedule`, {
        at: when === "later" ? new Date(at).toISOString() : null,
      });
      onClose(result.message);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save the campaign.");
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setProblem(null);
    setTestNote(null);
    setBusy("test");
    try {
      const result = await post<{ sentTo: string }>("/mail/bulk/test", { subject, body });
      setTestNote(`A test went to ${result.sentTo}.`);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not send the test.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (nobody || unfilled) return;
        if (preview && !window.confirm(`${when === "later" ? "Schedule" : "Send"} this to ${preview.count} ${preview.count === 1 ? "person" : "people"}?`)) return;
        void submit("send");
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{initial ? "Edit campaign" : "New campaign"}</h2>
        <button className="btn btn-ghost" type="button" onClick={() => onClose()}>
          Back
        </button>
      </div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {testNote ? <Notice tone="ok">{testNote}</Notice> : null}

      <section className="card space-y-4 p-4">
        <h3 className="font-semibold">1. The message</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Start from a template">
            <select className="field" value="" onChange={(event) => useTemplate(event.target.value)}>
              <option value="">Choose a template…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Kind">
            <select className="field" value={category} onChange={(event) => setCategory(event.target.value as Category)}>
              {(Object.keys(CATEGORY) as Category[]).map((key) => (
                <option key={key} value={key}>
                  {CATEGORY[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name (only you see this)">
            <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Christmas closure 2026" />
          </Field>
        </div>
        <Field label="Subject">
          <input className="field" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} required />
        </Field>
        <Field label="Message" hint="Use {{name}} for the person's name and {{client}} for their company. Your signature is added at the end.">
          <textarea className="field min-h-48" value={body} onChange={(event) => setBody(event.target.value)} required />
        </Field>
        {unfilled ? (
          <Notice tone="warn">Replace the [BRACKETED] parts, such as [DATE], before sending. It will not send until they are gone.</Notice>
        ) : null}
        <div>
          <button className="btn btn-sm btn-ghost" type="button" disabled={busy !== null || !subject.trim() || !body.trim() || !gmailReady} onClick={() => void sendTest()}>
            {busy === "test" ? <Spinner /> : null}
            Send a test to me
          </button>
        </div>
      </section>

      <section className="card space-y-4 p-4">
        <h3 className="font-semibold">2. Who gets it</h3>
        <AudiencePicker audience={audience} onChange={setAudience} contacts={contacts} options={options} />
        <p className={`text-sm ${nobody ? "text-rust" : "text-muted"}`}>
          {nobody
            ? "Pick at least one group, client or person."
            : preview
              ? `${preview.count} ${preview.count === 1 ? "person" : "people"} will get this${preview.sample.length ? `, including ${preview.sample.slice(0, 3).join(", ")}` : ""}.${
                  preview.skipped ? ` ${preview.skipped} marked "do not email" will be skipped.` : ""
                }`
              : "Counting…"}
        </p>
      </section>

      <section className="card space-y-3 p-4">
        <h3 className="font-semibold">3. When</h3>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="when" checked={when === "now"} onChange={() => setWhen("now")} /> Send right away
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="when" checked={when === "later"} onChange={() => setWhen("later")} /> Schedule for later
          </label>
        </div>
        {when === "later" ? (
          <Field label="Send at" hint="Uses the time zone of this device.">
            <input className="field max-w-xs" type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
          </Field>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" type="submit" disabled={busy !== null || nobody || unfilled || !gmailReady || !subject.trim() || !body.trim()}>
          {busy === "send" ? <Spinner /> : null}
          {when === "later" ? "Schedule it" : "Send now"}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy !== null || !subject.trim() || !body.trim()} onClick={() => void submit("draft")}>
          {busy === "save" ? <Spinner /> : null}
          Save as draft
        </button>
      </div>
    </form>
  );
}

function AudiencePicker({
  audience,
  onChange,
  contacts,
  options,
}: {
  audience: Audience;
  onChange: (next: Audience) => void;
  contacts: Contact[];
  options: Options;
}) {
  const [find, setFind] = useState("");
  const shown = useMemo(() => {
    const needle = find.trim().toLowerCase();
    return contacts.filter((contact) => !needle || contact.email.includes(needle) || contact.name.toLowerCase().includes(needle)).slice(0, 60);
  }, [contacts, find]);

  if (contacts.length === 0) {
    return <Notice tone="warn">There are no contacts yet. Open the Contacts tab to add people or import them.</Notice>;
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={audience.everyone} onChange={(event) => onChange({ ...audience, everyone: event.target.checked })} />
        Everyone in my contacts ({contacts.filter((contact) => !contact.doNotEmail).length})
      </label>
      {audience.everyone ? null : (
        <>
          {options.groups.length > 0 ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink/80">Groups</p>
              <div className="flex flex-wrap gap-2">
                {options.groups.map((group) => {
                  const on = audience.groups.includes(group);
                  return (
                    <button
                      key={group}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onChange({ ...audience, groups: toggle(audience.groups, group) })}
                      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${on ? "border-moss bg-moss text-paper" : "border-black/15 bg-surface hover:bg-black/5"}`}
                    >
                      {group} · {contacts.filter((contact) => contact.groups.includes(group)).length}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {options.clients.length > 0 ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink/80">Clients</p>
              <div className="flex flex-wrap gap-2">
                {options.clients.map((client) => {
                  const count = contacts.filter((contact) => contact.clientId === client.id).length;
                  const on = audience.clientIds.includes(client.id);
                  return (
                    <button
                      key={client.id}
                      type="button"
                      disabled={count === 0 && !on}
                      aria-pressed={on}
                      onClick={() => onChange({ ...audience, clientIds: toggle(audience.clientIds, client.id) })}
                      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${on ? "border-moss bg-moss text-paper" : "border-black/15 bg-surface hover:bg-black/5"}`}
                    >
                      {client.name} · {count}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink/80">
              Individual people{audience.contactIds.length ? ` · ${audience.contactIds.length} picked` : ""}
            </p>
            <input className="field mb-2" value={find} onChange={(event) => setFind(event.target.value)} placeholder="Search by name or email" aria-label="Search contacts" />
            <ul className="max-h-56 divide-y divide-black/5 overflow-auto rounded-xl border border-black/5 text-sm">
              {shown.map((contact) => (
                <li key={contact.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-black/[0.02]">
                    <input
                      type="checkbox"
                      checked={audience.contactIds.includes(contact.id)}
                      onChange={() => onChange({ ...audience, contactIds: toggle(audience.contactIds, contact.id) })}
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{contact.name || contact.email}</span>
                      {contact.name ? <span className="ml-2 text-muted">{contact.email}</span> : null}
                    </span>
                    {contact.doNotEmail ? <Badge tone="bad">Do not email</Badge> : null}
                  </label>
                </li>
              ))}
              {shown.length === 0 ? <li className="px-3 py-3 text-muted">No one matches.</li> : null}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Contacts ----

function splitGroups(text: string) {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ContactsTab({
  contacts,
  options,
  onChanged,
}: {
  contacts: ReturnType<typeof useResource<Contact[]>>;
  options: Options;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [groups, setGroups] = useState("");
  const [clientId, setClientId] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteGroup, setPasteGroup] = useState("");
  const [pasteClient, setPasteClient] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [find, setFind] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const rows = (contacts.data ?? []).filter((contact) => {
    const needle = find.trim().toLowerCase();
    return !needle || contact.email.includes(needle) || contact.name.toLowerCase().includes(needle) || contact.groups.some((group) => group.toLowerCase().includes(needle));
  });

  async function run(task: () => Promise<unknown>, done?: string) {
    setProblem(null);
    setNotice(null);
    try {
      await task();
      if (done) setNotice(done);
      onChanged();
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That did not work.");
      return false;
    }
  }

  async function runImport(body: Record<string, unknown>) {
    setProblem(null);
    setNotice(null);
    try {
      const result = await post<{ added: number; skipped: number }>("/mail/bulk/contacts/import", body);
      setNotice(`Added ${result.added}${result.skipped ? `, ${result.skipped} were already on the list` : ""}.`);
      onChanged();
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not import.");
      return false;
    }
  }

  return (
    <div className="space-y-4">
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {contacts.error ? <Notice tone="bad">{contacts.error}</Notice> : null}

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Add people</h2>
        <form
          className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => post("/mail/bulk/contacts", { email, name, groups: splitGroups(groups), clientId: clientId || null }),
              "Added.",
            ).then((ok) => {
              if (ok) {
                setEmail("");
                setName("");
              }
            });
          }}
        >
          <Field label="Email">
            <input className="field" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Field label="Name">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Groups" hint="Comma separated">
            <input className="field" value={groups} onChange={(event) => setGroups(event.target.value)} placeholder="Customers, Vendors" list="bulk-groups" />
          </Field>
          <Field label="Client">
            <select className="field" value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">None</option>
              {options.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary" type="submit">
              Add
            </button>
          </div>
        </form>
        <datalist id="bulk-groups">
          {options.groups.map((group) => (
            <option key={group} value={group} />
          ))}
        </datalist>
        <div className="flex flex-wrap gap-2 border-t border-black/5 pt-3">
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => void runImport({ source: "staff", group: "Staff" })}>
            Import my staff logins
          </button>
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => void runImport({ source: "letters", group: "Customers" })}>
            Import people who emailed us
          </button>
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setShowPaste(!showPaste)}>
            {showPaste ? "Close paste box" : "Paste a list"}
          </button>
        </div>
        {showPaste ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void runImport({ source: "paste", text: paste, group: pasteGroup, clientId: pasteClient || null }).then((ok) => {
                if (ok) setPaste("");
              });
            }}
          >
            <Field label="One person per line" hint="Like: Jane Smith, jane@company.com  or just the address.">
              <textarea className="field min-h-32 font-mono text-sm" value={paste} onChange={(event) => setPaste(event.target.value)} />
            </Field>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Put them in group">
                <input className="field" value={pasteGroup} onChange={(event) => setPasteGroup(event.target.value)} list="bulk-groups" />
              </Field>
              <Field label="Client">
                <select className="field" value={pasteClient} onChange={(event) => setPasteClient(event.target.value)}>
                  <option value="">None</option>
                  {options.clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end">
                <button className="btn btn-primary" type="submit" disabled={!paste.trim()}>
                  Import
                </button>
              </div>
            </div>
          </form>
        ) : null}
      </section>

      <div className="flex items-center justify-between gap-3">
        <input className="field max-w-sm" value={find} onChange={(event) => setFind(event.target.value)} placeholder="Search name, email or group" aria-label="Search contacts" />
        <p className="text-sm text-muted">{rows.length} shown</p>
      </div>
      {contacts.loading && !contacts.data ? <SkeletonList rows={3} /> : null}
      {contacts.data && contacts.data.length === 0 ? (
        <EmptyState title="No contacts yet">Add people above, or import your staff and the people who have emailed you.</EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <section className="card overflow-hidden">
          <ul className="divide-y divide-black/5">
            {rows.map((contact) =>
              editing === contact.id ? (
                <ContactEdit
                  key={contact.id}
                  contact={contact}
                  options={options}
                  onCancel={() => setEditing(null)}
                  onSave={(body) => run(() => api(`/mail/bulk/contacts/${contact.id}`, { method: "PUT", body: JSON.stringify(body) })).then((ok) => ok && setEditing(null))}
                />
              ) : (
                <li key={contact.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {contact.name || contact.email}
                      {contact.doNotEmail ? <span className="ml-2"><Badge tone="bad">Do not email</Badge></span> : null}
                    </p>
                    <p className="text-muted">
                      {contact.name ? `${contact.email} · ` : ""}
                      {contact.clientName ? `${contact.clientName} · ` : ""}
                      {contact.groups.length ? contact.groups.join(", ") : "No group"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditing(contact.id)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Remove ${contact.email}?`)) void run(() => api(`/mail/bulk/contacts/${contact.id}`, { method: "DELETE" }));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ContactEdit({
  contact,
  options,
  onCancel,
  onSave,
}: {
  contact: Contact;
  options: Options;
  onCancel: () => void;
  onSave: (body: { name: string; groups: string[]; clientId: string | null; doNotEmail: boolean }) => void;
}) {
  const [name, setName] = useState(contact.name);
  const [groups, setGroups] = useState(contact.groups.join(", "));
  const [clientId, setClientId] = useState(contact.clientId ?? "");
  const [doNotEmail, setDoNotEmail] = useState(contact.doNotEmail);
  return (
    <li className="px-4 py-3">
      <form
        className="grid gap-3 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, groups: splitGroups(groups), clientId: clientId || null, doNotEmail });
        }}
      >
        <p className="text-sm font-medium md:col-span-4">{contact.email}</p>
        <Field label="Name">
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Groups" hint="Comma separated">
          <input className="field" value={groups} onChange={(event) => setGroups(event.target.value)} list="bulk-groups" />
        </Field>
        <Field label="Client">
          <select className="field" value={clientId} onChange={(event) => setClientId(event.target.value)}>
            <option value="">None</option>
            {options.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={doNotEmail} onChange={(event) => setDoNotEmail(event.target.checked)} />
          Do not email this person
        </label>
        <div className="flex gap-2 md:col-span-4">
          <button className="btn btn-primary btn-sm" type="submit">
            Save
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </li>
  );
}

// ---- Settings and templates ----

function SettingsTab({
  settings,
  templates,
}: {
  settings: ReturnType<typeof useResource<Settings>>;
  templates: ReturnType<typeof useResource<Template[]>>;
}) {
  const saved = settings.data;
  const [senderName, setSenderName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [signature, setSignature] = useState("");
  const [dailyLimit, setDailyLimit] = useState(400);
  const [perMinute, setPerMinute] = useState(30);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState("");

  const key = saved ? JSON.stringify(saved) : "";
  if (saved && key !== loadedKey) {
    setLoadedKey(key);
    setSenderName(saved.senderName);
    setReplyTo(saved.replyTo);
    setSignature(saved.signature);
    setDailyLimit(saved.dailyLimit);
    setPerMinute(saved.perMinute);
  }

  const [tName, setTName] = useState("");
  const [tCategory, setTCategory] = useState<Category>("holiday");
  const [tSubject, setTSubject] = useState("");
  const [tBody, setTBody] = useState("");

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNotice(null);
    try {
      await api("/mail/bulk/settings", {
        method: "PUT",
        body: JSON.stringify({ senderName, replyTo, signature, dailyLimit, perMinute }),
      });
      setNotice("Settings saved.");
      settings.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save the settings.");
    }
  }

  async function addTemplate(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNotice(null);
    try {
      await post("/mail/bulk/templates", { name: tName, category: tCategory, subject: tSubject, body: tBody });
      setTName("");
      setTSubject("");
      setTBody("");
      setNotice("Template saved.");
      templates.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save the template.");
    }
  }

  return (
    <div className="space-y-5">
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      <form className="card space-y-4 p-4" onSubmit={saveSettings}>
        <div>
          <h2 className="font-semibold">Sending settings</h2>
          <p className="mt-1 text-sm text-muted">
            {saved?.gmailAccount ? `Messages go out from ${saved.gmailAccount}.` : "Connect Gmail in Settings to send."}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Sender name" hint="Shown as the sender, for example your company name.">
            <input className="field" value={senderName} onChange={(event) => setSenderName(event.target.value)} maxLength={80} />
          </Field>
          <Field label="Reply-to address" hint="Optional. Replies go here instead of the Gmail account.">
            <input className="field" type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} />
          </Field>
        </div>
        <Field label="Signature" hint="Added to the end of every bulk email.">
          <textarea className="field min-h-24" value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={2000} />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Most emails per day" hint="Gmail allows about 500 a day, or 2,000 on Google Workspace. Stay under it. A campaign that hits the limit carries on the next day.">
            <input className="field" type="number" min={1} max={2000} value={dailyLimit} onChange={(event) => setDailyLimit(Number(event.target.value))} />
          </Field>
          <Field label="Most emails per minute" hint="Spreads a big campaign out so Gmail does not block it.">
            <input className="field" type="number" min={1} max={120} value={perMinute} onChange={(event) => setPerMinute(Number(event.target.value))} />
          </Field>
        </div>
        <button className="btn btn-primary" type="submit">
          Save settings
        </button>
      </form>

      <section className="card space-y-4 p-4">
        <div>
          <h2 className="font-semibold">Templates</h2>
          <p className="mt-1 text-sm text-muted">Ready-made messages you can start a campaign from. Write [CAPITALS IN BRACKETS] where a person must fill something in.</p>
        </div>
        <ul className="divide-y divide-black/5 rounded-xl border border-black/5">
          {(templates.data ?? []).map((template) => (
            <li key={template.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {template.name} <span className="ml-1 text-xs text-muted">{CATEGORY[template.category]}</span>
                </p>
                <p className="truncate text-muted">{template.subject}</p>
              </div>
              <button
                className="btn btn-sm btn-danger"
                type="button"
                onClick={() => {
                  if (!window.confirm(`Delete the template "${template.name}"?`)) return;
                  api(`/mail/bulk/templates/${template.id}`, { method: "DELETE" })
                    .then(() => templates.reload())
                    .catch((err: unknown) => setProblem(err instanceof ApiError ? err.message : "Could not delete it."));
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        <form className="space-y-3 border-t border-black/5 pt-4" onSubmit={addTemplate}>
          <p className="text-sm font-medium">Add a template</p>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name">
              <input className="field" value={tName} onChange={(event) => setTName(event.target.value)} required />
            </Field>
            <Field label="Kind">
              <select className="field" value={tCategory} onChange={(event) => setTCategory(event.target.value as Category)}>
                {(Object.keys(CATEGORY) as Category[]).map((item) => (
                  <option key={item} value={item}>
                    {CATEGORY[item]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Subject">
              <input className="field" value={tSubject} onChange={(event) => setTSubject(event.target.value)} required />
            </Field>
          </div>
          <Field label="Message">
            <textarea className="field min-h-28" value={tBody} onChange={(event) => setTBody(event.target.value)} required />
          </Field>
          <button className="btn btn-ghost" type="submit">
            Save template
          </button>
        </form>
      </section>
    </div>
  );
}
