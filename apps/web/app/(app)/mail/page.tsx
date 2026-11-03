"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, post } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Badge, EmptyState, initials, Notice, PageTitle, SkeletonList, Spinner, timeAgo, useResource } from "@/components/ui";

type Status = { gmail: boolean; warehance: boolean; slack: boolean; claude: boolean };
type Rule = { id: string; name: string; enabled: boolean };
type Letter = {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  body: string;
  receivedAt: string;
  clientId: string | null;
  status: string;
};
type RunSummary = { id: string; letterId: string; status: "working" | "done" | "failed"; sentAt: string | null };

// Runs one rule on this email now, even if it arrived before the rule existed.
function RunRule({ letterId, rules }: { letterId: string; rules: Rule[] }) {
  const [ruleId, setRuleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (rules.length === 0) {
    return (
      <p className="text-sm text-muted">
        No rules yet.{" "}
        <Link className="font-medium text-moss hover:underline" href="/mail/automation">
          Create one in Email automation.
        </Link>
      </p>
    );
  }

  async function run() {
    setNote(null);
    setProblem(null);
    setBusy(true);
    try {
      await post(`/mail/letters/${letterId}/run`, { ruleId });
      setNote("Started. The draft appears in Email automation in a moment.");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not start the rule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select className="field max-w-xs" aria-label="Rule to run" value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
          <option value="">Run a rule on this email…</option>
          {rules.map((rule) => (
            <option key={rule.id} value={rule.id}>
              {rule.name}
              {rule.enabled ? "" : " (off)"}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="button" disabled={!ruleId || busy} onClick={run}>
          {busy ? <Spinner /> : null}
          Run
        </button>
      </div>
      {note ? (
        <Notice tone="ok">
          {note}{" "}
          <Link className="font-medium underline" href="/mail/automation">
            Open drafts
          </Link>
        </Notice>
      ) : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </div>
  );
}

// One line per connector, so it is obvious what is still missing.
function Setup({ status, owner }: { status: Status; owner: boolean }) {
  const items: [string, boolean][] = [
    ["Gmail", status.gmail],
    ["Claude", status.claude],
    ["Warehance bot", status.warehance],
    ["Slack", status.slack],
  ];
  if (items.every(([, ok]) => ok)) return null;
  return (
    <section className="card mb-5 flex flex-wrap items-center justify-between gap-4 p-4">
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-semibold">
          {status.gmail ? "Finish setup to unlock replies" : "Connect Gmail so letters can arrive"}
        </p>
        <div className="flex flex-wrap gap-2">
          {items.map(([name, ok]) => (
            <Badge key={name} tone={ok ? "ok" : "neutral"} dot>
              {name}
              {ok ? "" : " not connected"}
            </Badge>
          ))}
        </div>
      </div>
      {owner ? (
        <Link className="btn btn-primary" href="/settings">
          Open Settings
        </Link>
      ) : (
        <p className="text-sm text-muted">Ask the owner to connect them.</p>
      )}
    </section>
  );
}

export default function MailPage() {
  const user = useSession();
  const allowed = user?.role === "owner" || user?.role === "warehouse_manager";
  const { data, error, loading } = useResource<Status>(allowed ? "/mail/status" : null);
  const letters = useResource<Letter[]>(allowed && data?.gmail ? "/mail/letters" : null);
  const rules = useResource<Rule[]>(allowed ? "/mail/rules" : null);
  const runs = useResource<RunSummary[]>(allowed && data?.gmail ? "/mail/runs" : null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function checkNow() {
    setChecking(true);
    setProblem(null);
    try {
      await post("/mail/sync", {});
      letters.reload();
      runs.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not check the mailbox.");
    } finally {
      setChecking(false);
    }
  }

  if (!user) return <SkeletonList rows={2} />;
  if (!allowed) return <Notice tone="bad">Mail is for the warehouse manager.</Notice>;

  // The newest draft decides the badge shown on a letter.
  const stateOf = (letterId: string) => {
    const mine = (runs.data ?? []).filter((run) => run.letterId === letterId);
    if (mine.some((run) => run.sentAt)) return <Badge tone="ok" dot>Replied</Badge>;
    if (mine.some((run) => run.status === "working")) return <Badge tone="warn" dot>Writing draft</Badge>;
    if (mine.some((run) => run.status === "done")) return <Badge tone="ok">Draft ready</Badge>;
    if (mine.some((run) => run.status === "failed")) return <Badge tone="bad">Draft failed</Badge>;
    return null;
  };

  return (
    <div className="max-w-4xl">
      <PageTitle
        kicker="Mail"
        title="Inbox"
        detail="Letters from the warehouse mailbox. Nothing is answered or sent until a person approves it."
        actions={
          data?.gmail ? (
            <button className="btn" type="button" disabled={checking} onClick={checkNow}>
              {checking ? <Spinner /> : null}
              {checking ? "Checking" : "Check now"}
            </button>
          ) : null
        }
      />

      {loading ? <SkeletonList rows={4} /> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {problem ? (
        <div className="mb-4">
          <Notice tone="bad">{problem}</Notice>
        </div>
      ) : null}
      {data ? <Setup status={data} owner={user.role === "owner"} /> : null}

      {data?.gmail ? (
        <div className="space-y-3">
          {letters.error ? <Notice tone="bad">{letters.error}</Notice> : null}
          {letters.loading && !letters.data ? <SkeletonList rows={4} /> : null}
          {letters.data && letters.data.length === 0 ? (
            <EmptyState title="No letters yet">Mail from the last 7 days appears here after the next check. New mail is checked every minute.</EmptyState>
          ) : null}

          {letters.data && letters.data.length > 0 ? (
            <section className="card divide-y divide-black/5 overflow-hidden">
              {letters.data.map((letter) => {
                const isOpen = open === letter.id;
                const who = letter.fromName || letter.fromEmail;
                return (
                  <article key={letter.id} className={isOpen ? "bg-white" : ""}>
                    <button
                      className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-black/[0.03]"
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : letter.id)}
                    >
                      <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-moss/15 text-sm font-semibold text-moss">{initials(who)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="truncate font-semibold">{who}</span>
                          <span className="flex-none text-xs text-muted" title={new Date(letter.receivedAt).toLocaleString()}>
                            {timeAgo(letter.receivedAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-sm font-medium">{letter.subject || "(no subject)"}</span>
                        {!isOpen ? <span className="mt-0.5 block truncate text-sm text-muted">{letter.body || "(empty)"}</span> : null}
                        <span className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden">
                          {stateOf(letter.id)}
                          {letter.clientId ? <Badge>Matched to a client</Badge> : null}
                        </span>
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="space-y-4 border-t border-black/5 px-4 pb-4 pl-[4.25rem] pt-3">
                        <p className="text-xs text-muted">
                          From {letter.fromEmail} · {new Date(letter.receivedAt).toLocaleString()}
                        </p>
                        <p className="max-h-80 overflow-y-auto whitespace-pre-wrap text-sm leading-6">{letter.body || "(empty)"}</p>
                        <RunRule letterId={letter.id} rules={rules.data ?? []} />
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
