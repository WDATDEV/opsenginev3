"use client";

import { useEffect, useState } from "react";
import { api, ApiError, post } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";

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

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export default function AutomationPage() {
  const user = useSession();
  const allowed = user?.role === "owner" || user?.role === "warehouse_manager";
  const rules = useResource<Rule[]>(allowed ? "/mail/rules" : null);
  const runs = useResource<Run[]>(allowed ? "/mail/runs" : null);
  const [form, setForm] = useState<Form | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

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
    try {
      if (form.id) await api(`/mail/rules/${form.id}`, { method: "PUT", body: JSON.stringify(toPayload(form)) });
      else await post("/mail/rules", toPayload(form));
      setNotice("Rule saved.");
      setForm(null);
      rules.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save the rule.");
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

  if (!user) return <p className="text-muted">Loading…</p>;
  if (!allowed) return <Notice tone="bad">Email automation is for the warehouse manager.</Notice>;

  return (
    <div className="max-w-3xl space-y-6">
      <PageTitle
        kicker="Mail"
        title="Email automation"
        detail="Choose which emails a rule picks up. It can write a draft reply with Claude, look up Warehance data, attach a spreadsheet, and tell people in Slack. Nothing is ever sent to a client."
      />
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Rules</h2>
          {!form ? (
            <button className="btn btn-primary" type="button" onClick={() => setForm(blank())}>
              New rule
            </button>
          ) : null}
        </div>
        {form ? <Editor form={form} onChange={setForm} onSave={save} onCancel={() => setForm(null)} /> : null}
        {rules.error ? <Notice tone="bad">{rules.error}</Notice> : null}
        {rules.data && rules.data.length === 0 && !form ? (
          <section className="card p-5 text-sm">No rules yet. A new rule only acts on emails that arrive after it exists. To try one now, open an email in the Inbox and use Run a rule.</section>
        ) : null}
        {rules.data?.map((rule) => (
          <section key={rule.id} className="card space-y-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{rule.name}</p>
                <p className="text-sm text-muted">When {describe(rule)}</p>
                <p className="text-sm text-muted">
                  {[
                    rule.draft.enabled ? `Draft with Claude ${rule.draft.model === "sonnet" ? "Sonnet" : "Haiku"}` : null,
                    rule.draft.enabled && rule.draft.useWarehance ? `Warehance client ${rule.draft.warehanceClientId}` : null,
                    rule.draft.enabled && rule.draft.spreadsheet ? "spreadsheet" : null,
                    rule.slack.enabled ? "Slack" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn" type="button" onClick={() => toggle(rule)}>
                  {rule.enabled ? "Turn off" : "Turn on"}
                </button>
                <button className="btn" type="button" onClick={() => setForm(toForm(rule))}>
                  Edit
                </button>
                <button className="btn" type="button" onClick={() => remove(rule)}>
                  Delete
                </button>
              </div>
            </div>
            {!rule.enabled ? <p className="text-sm text-rust">Off. This rule is not picking up emails.</p> : null}
          </section>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Drafts</h2>
        {runs.error ? <Notice tone="bad">{runs.error}</Notice> : null}
        {runs.data && runs.data.length === 0 ? <section className="card p-5 text-sm">No drafts yet.</section> : null}
        {runs.data?.map((run) => (
          <section key={run.id} className="card space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{run.subject || "(no subject)"}</p>
                <p className="text-sm text-muted">
                  {run.fromEmail} · {run.ruleName} · {new Date(run.createdAt).toLocaleString()}
                </p>
              </div>
              <span className={`text-sm ${run.status === "failed" ? "text-rust" : run.status === "working" ? "text-muted" : "text-moss"}`}>
                {run.status === "working" ? "Writing…" : run.status === "failed" ? "Failed" : "Draft ready"}
              </span>
            </div>
            {run.error ? <Notice tone="bad">{run.error}</Notice> : null}
            {run.needsReview ? <Notice tone="bad">Needs a person before it goes anywhere: {run.reviewReason || "check the draft."}</Notice> : null}
            {run.draftBody ? (
              <div className="rounded-xl bg-white p-3 text-sm">
                <p className="font-semibold">{run.draftSubject}</p>
                <p className="mt-2 whitespace-pre-wrap">{run.draftBody}</p>
              </div>
            ) : null}
            {run.attachmentName ? (
              <a className="btn inline-block" href={`${API_URL}/mail/runs/${run.id}/attachment`}>
                Download {run.attachmentName}
              </a>
            ) : null}
            {run.lookups.length > 0 ? (
              <details className="text-sm text-muted">
                <summary className="cursor-pointer">Warehance lookups ({run.lookups.length})</summary>
                <ul className="mt-1 list-disc pl-5">
                  {run.lookups.map((lookup, index) => (
                    <li key={index}>{lookup.summary}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {run.slackNote ? <p className="text-sm text-muted">Slack: {run.slackNote}</p> : null}
            {run.model ? <p className="text-xs text-muted">Written by {run.model}. Draft only, nothing was sent.</p> : null}
          </section>
        ))}
      </section>
    </div>
  );
}

function Editor({
  form,
  onChange,
  onSave,
  onCancel,
}: {
  form: Form;
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
    <section className="card space-y-5 p-5">
      <Field label="Rule name">
        <input className="field" placeholder="Acme tracking requests" value={form.name} onChange={(event) => set({ name: event.target.value })} />
      </Field>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">When an email matches</span>
          <select className="field w-auto" value={form.matchMode} onChange={(event) => set({ matchMode: event.target.value as "all" | "any" })}>
            <option value="all">all of these</option>
            <option value="any">any of these</option>
          </select>
        </div>
        {form.conditions.map((condition, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select className="field w-auto" value={condition.field} onChange={(event) => setCondition(index, { field: event.target.value as FieldName })}>
              {FIELDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select className="field w-auto" value={condition.op} onChange={(event) => setCondition(index, { op: event.target.value as Op })}>
              {OPS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              className="field min-w-[12rem] flex-1"
              placeholder="tracking, where is my order"
              value={condition.value}
              onChange={(event) => setCondition(index, { value: event.target.value })}
            />
            {form.conditions.length > 1 ? (
              <button className="btn" type="button" onClick={() => set({ conditions: form.conditions.filter((_, at) => at !== index) })}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
        <button className="btn" type="button" onClick={() => set({ conditions: [...form.conditions, { field: "subject", op: "contains_any", value: "" }] })}>
          Add condition
        </button>
        <p className="text-sm text-muted">Separate several words with commas. Capital letters do not matter. Sender domain looks like acme.com.</p>
      </div>

      <div className="space-y-3 border-t border-black/10 pt-4">
        <Check label="Write a draft reply with Claude" checked={form.draft.enabled} onChange={(enabled) => setDraft({ enabled })} />
        {form.draft.enabled ? (
          <div className="space-y-3 pl-6">
            <Field label="How should the reply be written?">
              <textarea
                className="field min-h-[6rem]"
                placeholder="Friendly and short. Give the carrier and tracking number. Sign off as the Acme support desk."
                value={form.draft.instructions}
                onChange={(event) => setDraft({ instructions: event.target.value })}
              />
            </Field>
            <Field label="Facts the reply may use (hours, addresses, prices, policies)">
              <textarea
                className="field min-h-[8rem]"
                placeholder={"Opening hours: Monday to Friday 8:00 am to 5:00 pm. Closed on weekends and public holidays.\nWalk-in drop-offs: accepted weekdays 9:00 am to 4:00 pm at Dock 2. Please call ahead for pallets.\nAddress: 100 Warehouse Road, Austin, TX 78701."}
                value={form.draft.facts}
                onChange={(event) => setDraft({ facts: event.target.value })}
              />
            </Field>
            <p className="text-sm text-muted">Claude quotes only what is written here and in the Warehance lookups. Anything else, it says the team will check.</p>
            <Field label="Claude model">
              <select className="field w-auto" value={form.draft.model} onChange={(event) => setDraft({ model: event.target.value as "haiku" | "sonnet" })}>
                <option value="haiku">Haiku (fast, low cost)</option>
                <option value="sonnet">Sonnet (for harder letters)</option>
              </select>
            </Field>
            <Check label="Look up Warehance data when the email needs it" checked={form.draft.useWarehance} onChange={(useWarehance) => setDraft({ useWarehance })} />
            {form.draft.useWarehance ? (
              <div className="space-y-3 pl-6">
                <Field label="Warehance client">
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
                {clients.loading ? <p className="text-sm text-muted">Loading your Warehance clients…</p> : null}
                {clients.data && !clients.data.connected ? (
                  <p className="text-sm text-muted">The Warehance bot is not connected, so type the client ID. Connect it in Settings to pick from a list.</p>
                ) : null}
                {clients.data?.error ? <p className="text-sm text-rust">Could not load the client list: {clients.data.error} Type the client ID instead.</p> : null}
                <p className="text-sm text-muted">Every lookup is limited to this one client, so a letter cannot pull in another brand’s data.</p>
                <Check label="Attach a spreadsheet when the sender asks for a list or export" checked={form.draft.spreadsheet} onChange={(spreadsheet) => setDraft({ spreadsheet })} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-black/10 pt-4">
        <Check label="Send a Slack message" checked={form.slack.enabled} onChange={(enabled) => setSlack({ enabled })} />
        {form.slack.enabled ? (
          <div className="space-y-3 pl-6">
            <Field label="Channels (several allowed, separated by commas)">
              <input className="field" placeholder="#client-mail, #ops-alerts" value={form.slack.channel} onChange={(event) => setSlack({ channel: event.target.value })} />
            </Field>
            <p className="text-sm text-muted">The bot must be in each channel. Use /invite @bot in the channel, or give the bot the chat:write.public scope. Leave this empty to use the default channel from Settings, if one is set.</p>
            <Field label="Mention in the channel">
              <input
                className="field"
                placeholder="maria@company.com, @jorge, U024BE7LH"
                value={form.slack.mentions}
                onChange={(event) => setSlack({ mentions: event.target.value })}
              />
            </Field>
            <Field label="Also send a direct message to">
              <input className="field" placeholder="maria@company.com" value={form.slack.direct} onChange={(event) => setSlack({ direct: event.target.value })} />
            </Field>
            <p className="text-sm text-muted">Use an email address, a Slack @name, or a member ID. Email and name lookups need the users:read and users:read.email scopes on the Slack bot.</p>
            <Check label="Include the draft text in the Slack message" checked={form.slack.includeDraft} onChange={(includeDraft) => setSlack({ includeDraft })} />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-black/10 pt-4">
        <button className="btn btn-primary" type="button" onClick={onSave}>
          Save rule
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <Check label="Rule is on" checked={form.enabled} onChange={(enabled) => set({ enabled })} />
      </div>
    </section>
  );
}
