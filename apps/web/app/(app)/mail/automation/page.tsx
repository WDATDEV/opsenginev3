"use client";

import { useEffect, useState } from "react";
import { api, ApiError, post } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, Field, initials, Notice, PageTitle, SkeletonList, Spinner, Switch, timeAgo, useResource } from "@/components/ui";

type FieldName = "subject" | "body" | "sender" | "domain";
type Op = "contains_any" | "contains_all" | "not_contains" | "equals" | "ends_with";
type Condition = { field: FieldName; op: Op; value: string };

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  matchMode: "all" | "any";
  conditions: Condition[];
  draft: {
    enabled: boolean;
    instructions: string;
    facts?: string;
    model: "haiku" | "sonnet";
    useWarehance: boolean;
    warehanceClientId: number | null;
    spreadsheet: boolean;
  };
  slack: { enabled: boolean; channel: string; mentions: string[]; direct: string[]; includeDraft: boolean };
};

type Run = {
  id: string;
  status: "working" | "done" | "failed";
  subject: string;
  fromEmail: string;
  ruleName: string;
  draftSubject: string | null;
  draftBody: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  attachmentName: string | null;
  lookups: { tool: string; summary: string }[];
  slackNote: string | null;
  error: string | null;
  model: string | null;
  createdAt: string;
  sentAt: string | null;
  sentTo: string | null;
};

// The form keeps people and the client id as text, then converts them when saving.
type Form = {
  id?: string;
  name: string;
  enabled: boolean;
  matchMode: "all" | "any";
  conditions: Condition[];
  draft: { enabled: boolean; instructions: string; facts: string; model: "haiku" | "sonnet"; useWarehance: boolean; clientId: string; spreadsheet: boolean };
  slack: { enabled: boolean; channel: string; mentions: string; direct: string; includeDraft: boolean };
};

const FIELDS: [FieldName, string][] = [
  ["subject", "Subject"],
  ["body", "Body"],
  ["sender", "Sender address"],
  ["domain", "Sender domain"],
];

const OPS: [Op, string][] = [
  ["contains_any", "contains any of"],
  ["contains_all", "contains all of"],
  ["not_contains", "contains none of"],
  ["equals", "is exactly"],
  ["ends_with", "ends with"],
];

const blank = (): Form => ({
  name: "",
  enabled: true,
  matchMode: "all",
  conditions: [{ field: "subject", op: "contains_any", value: "" }],
  draft: { enabled: true, instructions: "", facts: "", model: "haiku", useWarehance: false, clientId: "", spreadsheet: false },
  slack: { enabled: false, channel: "", mentions: "", direct: "", includeDraft: false },
});

const toForm = (rule: Rule): Form => ({
  id: rule.id,
  name: rule.name,
  enabled: rule.enabled,
  matchMode: rule.matchMode,
  conditions: rule.conditions,
  draft: {
    enabled: rule.draft.enabled,
    instructions: rule.draft.instructions,
    facts: rule.draft.facts ?? "",
    model: rule.draft.model,
    useWarehance: rule.draft.useWarehance,
    clientId: rule.draft.warehanceClientId ? String(rule.draft.warehanceClientId) : "",
    spreadsheet: rule.draft.spreadsheet,
  },
  slack: {
    enabled: rule.slack.enabled,
    channel: rule.slack.channel,
    mentions: rule.slack.mentions.join(", "),
    direct: rule.slack.direct.join(", "),
    includeDraft: rule.slack.includeDraft,
  },
});

const people = (text: string) =>
  text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const toPayload = (form: Form) => ({
  name: form.name,
  enabled: form.enabled,
  matchMode: form.matchMode,
  conditions: form.conditions,
  draft: {
    enabled: form.draft.enabled,
    instructions: form.draft.instructions,
    facts: form.draft.facts,
    model: form.draft.model,
    useWarehance: form.draft.useWarehance,
    warehanceClientId: form.draft.clientId.trim() ? Number(form.draft.clientId) : null,
    spreadsheet: form.draft.useWarehance && form.draft.spreadsheet,
  },
  slack: {
    enabled: form.slack.enabled,
    channel: form.slack.channel,
    mentions: people(form.slack.mentions),
    direct: people(form.slack.direct),
    includeDraft: form.slack.includeDraft,
  },
});

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

function describe(rule: Rule) {
  const label = (condition: Condition) =>
    `${FIELDS.find(([field]) => field === condition.field)?.[1] ?? condition.field} ${OPS.find(([op]) => op === condition.op)?.[1] ?? condition.op} “${condition.value}”`;
  return rule.conditions.map(label).join(rule.matchMode === "all" ? " and " : " or ");
}

export default function AutomationPage() {
  const user = useSession();
  const allowed = user?.role === "owner" || user?.role === "warehouse_manager";
  const rules = useResource<Rule[]>(allowed ? "/mail/rules" : null);
  const runs = useResource<Run[]>(allowed ? "/mail/runs" : null);
  const [form, setForm] = useState<Form | null>(null);
  const [tab, setTab] = useState<"drafts" | "rules">("drafts");
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Drafts take a while. While one is still being written, the list refreshes itself.
  const working = runs.data?.some((run) => run.status === "working") ?? false;
  const reloadRuns = runs.reload;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(reloadRuns, 4000);
    return () => clearInterval(timer);
  }, [working, reloadRuns]);

  async function save() {
    if (!form) return;
    setNotice(null);
    setProblem(null);
    setSaving(true);
    try {
      if (form.id) await api(`/mail/rules/${form.id}`, { method: "PUT", body: JSON.stringify(toPayload(form)) });
      else await post("/mail/rules", toPayload(form));
      setNotice("Rule saved.");
      setForm(null);
      rules.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save the rule.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: Rule) {
    setProblem(null);
    try {
      await api(`/mail/rules/${rule.id}`, {
        method: "PUT",
        body: JSON.stringify(toPayload({ ...toForm(rule), enabled: !rule.enabled })),
      });
      rules.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not change the rule.");
    }
  }

  async function remove(rule: Rule) {
    if (!window.confirm(`Delete the rule "${rule.name}"?`)) return;
    setProblem(null);
    try {
      await api(`/mail/rules/${rule.id}`, { method: "DELETE" });
      rules.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not delete the rule.");
    }
  }

  function startEditing(next: Form) {
    setNotice(null);
    setProblem(null);
    setTab("rules");
    setForm(next);
  }

  if (!user) return <SkeletonList rows={2} />;
  if (!allowed) return <Notice tone="bad">Email automation is for the warehouse manager.</Notice>;

  const waiting = (runs.data ?? []).filter((run) => run.status === "done" && !run.sentAt).length;

  return (
    <div className="max-w-4xl">
      <PageTitle
        kicker="Mail"
        title="Email automation"
        detail="Choose which emails a rule picks up. It can write a draft reply with Claude, look up Warehance data, attach a spreadsheet, and tell people in Slack. Claude only writes drafts. A person reads each one, edits it if needed, and clicks Send."
        actions={
          !form ? (
            <button className="btn btn-primary" type="button" onClick={() => startEditing(blank())}>
              <span aria-hidden="true">+</span> New rule
            </button>
          ) : null
        }
      />

      <div className="space-y-4">
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
      </div>

      {form ? (
        <Editor form={form} saving={saving} onChange={setForm} onSave={save} onCancel={() => setForm(null)} />
      ) : (
        <>
          {/* Tabs */}
          <div className="mb-5 mt-2 inline-flex rounded-xl bg-black/5 p-1" role="tablist">
            {(
              [
                ["drafts", "Drafts", waiting],
                ["rules", "Rules", rules.data?.length ?? 0],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  tab === id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {label}
                {count > 0 ? <span className={`rounded-full px-1.5 text-xs ${tab === id ? "bg-moss/15 text-moss" : "bg-black/10"}`}>{count}</span> : null}
              </button>
            ))}
          </div>

          {tab === "rules" ? (
            <section className="space-y-3" aria-label="Rules">
              {rules.error ? <Notice tone="bad">{rules.error}</Notice> : null}
              {rules.loading && !rules.data ? <SkeletonList rows={2} /> : null}
              {rules.data && rules.data.length === 0 ? (
                <EmptyState
                  title="No rules yet"
                  action={
                    <button className="btn btn-primary" type="button" onClick={() => startEditing(blank())}>
                      Create your first rule
                    </button>
                  }
                >
                  A new rule only acts on emails that arrive after it exists. To try one on an older email, open it in the Inbox and use Run a rule.
                </EmptyState>
              ) : null}
              {rules.data?.map((rule) => (
                <article key={rule.id} className={`card card-hover space-y-3 p-4 sm:p-5 ${rule.enabled ? "" : "opacity-75"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold">{rule.name}</h3>
                      <p className="mt-1 text-sm text-muted">When {describe(rule)}</p>
                    </div>
                    <Switch label={rule.enabled ? "On" : "Off"} checked={rule.enabled} onChange={() => toggle(rule)} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {rule.draft.enabled ? <Badge tone="ok">Claude {rule.draft.model === "sonnet" ? "Sonnet" : "Haiku"}</Badge> : null}
                      {rule.draft.enabled && rule.draft.useWarehance ? <Badge>Warehance client {rule.draft.warehanceClientId}</Badge> : null}
                      {rule.draft.enabled && rule.draft.spreadsheet ? <Badge>Spreadsheet</Badge> : null}
                      {rule.slack.enabled ? <Badge>Slack</Badge> : null}
                    </div>
                    <div className="flex gap-2">
                      <button className="btn btn-sm" type="button" onClick={() => startEditing(toForm(rule))}>
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" type="button" onClick={() => remove(rule)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {!rule.enabled ? <p className="text-sm text-clay">Off. This rule is not picking up emails.</p> : null}
                </article>
              ))}
            </section>
          ) : (
            <section className="space-y-3" aria-label="Drafts">
              {runs.error ? <Notice tone="bad">{runs.error}</Notice> : null}
              {runs.loading && !runs.data ? <SkeletonList rows={3} /> : null}
              {runs.data && runs.data.length === 0 ? (
                <EmptyState
                  title="No drafts yet"
                  action={
                    (rules.data?.length ?? 0) === 0 ? (
                      <button className="btn btn-primary" type="button" onClick={() => startEditing(blank())}>
                        Create a rule
                      </button>
                    ) : undefined
                  }
                >
                  When an email matches a rule, Claude writes a draft and it shows up here for you to review.
                </EmptyState>
              ) : null}
              {runs.data?.map((run) => (
                <article key={run.id} className="card space-y-3 p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-moss/15 text-sm font-semibold text-moss">{initials(run.fromEmail)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="min-w-0 truncate font-semibold">{run.subject || "(no subject)"}</p>
                        {run.sentAt ? (
                          <Badge tone="ok" dot>
                            Sent
                          </Badge>
                        ) : run.status === "working" ? (
                          <Badge tone="warn">
                            <Spinner /> Writing
                          </Badge>
                        ) : run.status === "failed" ? (
                          <Badge tone="bad" dot>
                            Failed
                          </Badge>
                        ) : (
                          <Badge tone="ok" dot>
                            Draft ready
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-muted">
                        {run.fromEmail} · {run.ruleName} · {timeAgo(run.createdAt)}
                      </p>
                    </div>
                  </div>

                  {run.error ? <Notice tone="bad">{run.error}</Notice> : null}
                  {run.needsReview ? <Notice tone="warn">Needs a person before it goes anywhere: {run.reviewReason || "check the draft."}</Notice> : null}
                  {run.draftBody ? <DraftBox run={run} onSent={runs.reload} /> : null}
                  {run.attachmentName ? (
                    <a className="btn btn-sm inline-flex" href={`${API_URL}/mail/runs/${run.id}/attachment`}>
                      Download {run.attachmentName}
                    </a>
                  ) : null}
                  {run.lookups.length > 0 ? (
                    <details className="group text-sm text-muted">
                      <summary className="cursor-pointer select-none font-medium hover:text-ink">Warehance lookups ({run.lookups.length})</summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {run.lookups.map((lookup, index) => (
                          <li key={index}>{lookup.summary}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {run.slackNote ? <p className="text-sm text-muted">Slack: {run.slackNote}</p> : null}
                  {run.model ? (
                    <p className="text-xs text-muted">Written by {run.model}. {run.sentAt ? "This reply was sent by a person." : "Nothing is sent until a person clicks Send."}</p>
                  ) : null}
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// The draft, open for editing. Send is the only place a reply can leave the app, and it asks first.
function DraftBox({ run, onSent }: { run: Run; onSent: () => void }) {
  const [subject, setSubject] = useState(run.draftSubject ?? "");
  const [body, setBody] = useState(run.draftBody ?? "");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (run.sentAt) {
    return (
      <div className="rounded-xl border border-moss/20 bg-white p-4 text-sm">
        <p className="font-semibold text-moss">
          Sent to {run.sentTo} · {new Date(run.sentAt).toLocaleString()}
        </p>
        <p className="mt-2 font-semibold">{run.draftSubject}</p>
        <p className="mt-1 whitespace-pre-wrap leading-6">{run.draftBody}</p>
      </div>
    );
  }

  async function send() {
    if (!window.confirm(`Send this reply to ${run.fromEmail}${run.attachmentName ? ` with ${run.attachmentName} attached` : ""}? It cannot be taken back.`)) return;
    setSending(true);
    setProblem(null);
    try {
      await post(`/mail/runs/${run.id}/send`, { subject, body });
      onSent();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not send the reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-black/10 bg-white p-4 text-sm">
      <div className="flex items-center gap-2 text-muted">
        <span className="w-12 flex-none">To</span>
        <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-ink">{run.fromEmail}</span>
      </div>
      <input className="field font-medium" aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
      <textarea className="field min-h-[10rem]" aria-label="Reply" value={body} onChange={(event) => setBody(event.target.value)} />
      {run.attachmentName ? <p className="text-muted">{run.attachmentName} will be attached.</p> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <div className="flex justify-end">
        <button className="btn btn-primary" type="button" disabled={sending || !subject.trim() || !body.trim()} onClick={send}>
          {sending ? <Spinner /> : null}
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
    </div>
  );
}

// One numbered block of the rule form.
function Step({ n, title, hint, children }: { n: number; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-moss text-sm font-semibold text-paper">{n}</span>
        <div>
          <h3 className="font-semibold leading-7">{title}</h3>
          <p className="text-sm text-muted">{hint}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Editor({
  form,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  form: Form;
  saving: boolean;
  onChange: (next: Form) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // The client list comes from the Warehance bot, and is only fetched once a rule asks for lookups.
  const clients = useResource<{ connected: boolean; clients: { id: number; name: string }[]; error?: string }>(
    form.draft.useWarehance ? "/mail/warehance/clients" : null,
  );
  const clientList = clients.data?.clients ?? [];
  const pickable = clientList.length > 0;

  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });
  const setDraft = (patch: Partial<Form["draft"]>) => onChange({ ...form, draft: { ...form.draft, ...patch } });
  const setSlack = (patch: Partial<Form["slack"]>) => onChange({ ...form, slack: { ...form.slack, ...patch } });
  const setCondition = (index: number, patch: Partial<Condition>) =>
    set({ conditions: form.conditions.map((condition, at) => (at === index ? { ...condition, ...patch } : condition)) });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{form.id ? "Edit rule" : "New rule"}</h2>

      <section className="card p-5 sm:p-6">
        <Field label="Rule name">
          <input className="field" placeholder="Acme tracking requests" value={form.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>
      </section>

      <Step n={1} title="When an email arrives" hint="Pick the emails this rule should act on.">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">It matches</span>
          <select className="field w-auto" aria-label="Match mode" value={form.matchMode} onChange={(event) => set({ matchMode: event.target.value as "all" | "any" })}>
            <option value="all">all of these</option>
            <option value="any">any of these</option>
          </select>
        </div>
        <div className="space-y-2">
          {form.conditions.map((condition, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 rounded-xl bg-black/[0.03] p-2">
              <select className="field w-auto" aria-label="Field" value={condition.field} onChange={(event) => setCondition(index, { field: event.target.value as FieldName })}>
                {FIELDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select className="field w-auto" aria-label="Operator" value={condition.op} onChange={(event) => setCondition(index, { op: event.target.value as Op })}>
                {OPS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                className="field min-w-[12rem] flex-1"
                aria-label="Words to look for"
                placeholder="tracking, where is my order"
                value={condition.value}
                onChange={(event) => setCondition(index, { value: event.target.value })}
              />
              {form.conditions.length > 1 ? (
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  aria-label="Remove condition"
                  title="Remove condition"
                  onClick={() => set({ conditions: form.conditions.filter((_, at) => at !== index) })}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <button className="btn btn-sm" type="button" onClick={() => set({ conditions: [...form.conditions, { field: "subject", op: "contains_any", value: "" }] })}>
          + Add condition
        </button>
        <p className="text-xs leading-5 text-muted">Separate several words with commas. Capital letters do not matter. Sender domain looks like acme.com.</p>
      </Step>

      <Step n={2} title="Write a reply" hint="Claude writes a draft. A person approves it before anything is sent.">
        <Switch label="Write a draft reply with Claude" checked={form.draft.enabled} onChange={(enabled) => setDraft({ enabled })} />
        {form.draft.enabled ? (
          <div className="space-y-4 border-l-2 border-moss/20 pl-4 sm:pl-5">
            <Field label="How should the reply be written?" hint="Tone and style only. Put facts in the box below.">
              <textarea
                className="field min-h-[6rem]"
                placeholder="Friendly and short. Give the carrier and tracking number. Sign off as the Acme support desk."
                value={form.draft.instructions}
                onChange={(event) => setDraft({ instructions: event.target.value })}
              />
            </Field>
            <Field label="Facts the reply may use (hours, addresses, prices, policies)" hint="Claude quotes only what is written here and in the Warehance lookups. Anything else, it says the team will check.">
              <textarea
                className="field min-h-[8rem]"
                placeholder={"Opening hours: Monday to Friday 8:00 am to 5:00 pm. Closed on weekends and public holidays.\nWalk-in drop-offs: accepted weekdays 9:00 am to 4:00 pm at Dock 2. Please call ahead for pallets.\nAddress: 100 Warehouse Road, Austin, TX 78701."}
                value={form.draft.facts}
                onChange={(event) => setDraft({ facts: event.target.value })}
              />
            </Field>
            <Field label="Claude model">
              <select className="field w-auto" value={form.draft.model} onChange={(event) => setDraft({ model: event.target.value as "haiku" | "sonnet" })}>
                <option value="haiku">Haiku (fast, low cost)</option>
                <option value="sonnet">Sonnet (for harder letters)</option>
              </select>
            </Field>

            <div className="space-y-4 rounded-xl bg-black/[0.03] p-4">
              <Switch
                label="Look up Warehance data when the email needs it"
                hint="For order status, tracking and stock questions."
                checked={form.draft.useWarehance}
                onChange={(useWarehance) => setDraft({ useWarehance })}
              />
              {form.draft.useWarehance ? (
                <div className="space-y-4">
                  <Field label="Warehance client" hint="Every lookup is limited to this one client, so a letter cannot pull in another brand’s data.">
                    {pickable ? (
                      <select className="field w-auto min-w-[16rem]" value={form.draft.clientId} onChange={(event) => setDraft({ clientId: event.target.value })}>
                        <option value="">Choose a client</option>
                        {/* Keeps a saved ID visible even when it is missing from the list. */}
                        {form.draft.clientId && !clientList.some((entry) => String(entry.id) === form.draft.clientId) ? (
                          <option value={form.draft.clientId}>Client ID {form.draft.clientId}</option>
                        ) : null}
                        {clientList.map((entry) => (
                          <option key={entry.id} value={String(entry.id)}>
                            {entry.name} (ID {entry.id})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="field w-40"
                        inputMode="numeric"
                        placeholder="Client ID"
                        value={form.draft.clientId}
                        onChange={(event) => setDraft({ clientId: event.target.value.replace(/\D/g, "") })}
                      />
                    )}
                  </Field>
                  {clients.loading ? <Spinner label="Loading your Warehance clients…" /> : null}
                  {clients.data && !clients.data.connected ? (
                    <p className="text-sm text-muted">The Warehance bot is not connected, so type the client ID. Connect it in Settings to pick from a list.</p>
                  ) : null}
                  {clients.data?.error ? <Notice tone="warn">Could not load the client list: {clients.data.error} Type the client ID instead.</Notice> : null}
                  <Switch
                    label="Attach a spreadsheet when the sender asks for a list or export"
                    checked={form.draft.spreadsheet}
                    onChange={(spreadsheet) => setDraft({ spreadsheet })}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Step>

      <Step n={3} title="Tell people in Slack" hint="Optional. Post in channels, mention someone, or send a direct message.">
        <Switch label="Send a Slack message" checked={form.slack.enabled} onChange={(enabled) => setSlack({ enabled })} />
        {form.slack.enabled ? (
          <div className="space-y-4 border-l-2 border-moss/20 pl-4 sm:pl-5">
            <Field
              label="Channels (several allowed, separated by commas)"
              hint="The bot must be in each channel. Use /invite @bot in the channel, or give the bot the chat:write.public scope."
            >
              <input className="field" placeholder="#client-mail, #ops-alerts" value={form.slack.channel} onChange={(event) => setSlack({ channel: event.target.value })} />
            </Field>
            <Field label="Mention in the channel">
              <input className="field" placeholder="maria@company.com, @jorge, U024BE7LH" value={form.slack.mentions} onChange={(event) => setSlack({ mentions: event.target.value })} />
            </Field>
            <Field
              label="Also send a direct message to"
              hint="Use an email address, a Slack @name, or a member ID. Email and name lookups need the users:read and users:read.email scopes on the Slack bot."
            >
              <input className="field" placeholder="maria@company.com" value={form.slack.direct} onChange={(event) => setSlack({ direct: event.target.value })} />
            </Field>
            <Switch label="Include the draft text in the Slack message" checked={form.slack.includeDraft} onChange={(includeDraft) => setSlack({ includeDraft })} />
          </div>
        ) : null}
      </Step>

      {/* Stays in view while the form scrolls, so Save is never lost */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/10 bg-surface/95 p-3 shadow-lg backdrop-blur">
        <Switch label={form.enabled ? "Rule is on" : "Rule is off"} checked={form.enabled} onChange={(enabled) => set({ enabled })} />
        <div className="flex gap-2">
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" type="button" disabled={saving} onClick={onSave}>
            {saving ? <Spinner /> : null}
            Save rule
          </button>
        </div>
      </div>
    </div>
  );
}
