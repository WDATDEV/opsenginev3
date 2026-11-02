"use client";

import { useState } from "react";
import { api, ApiError, post } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";

type Connector = { connected: boolean; label: string | null; detail: string | null; address: string | null };
type Connectors = { gmail: Connector; warehance: Connector; slack: Connector };

export default function SettingsPage() {
  const user = useSession();
  const { data, error, loading, reload } = useResource<Connectors>(user?.role === "owner" ? "/settings/connectors" : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(path: string, body: unknown) {
    setNotice(null);
    setProblem(null);
    try {
      await post(path, body);
      setNotice("Saved.");
      reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not update the connector.");
    }
  }

  async function test(kind: keyof Connectors) {
    setNotice(null);
    setProblem(null);
    try {
      const next = await post<Connectors>(`/settings/connectors/${kind}/test`, {});
      setNotice(next[kind]?.detail ?? "Connection checked.");
      reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not test the connector.");
    }
  }

  async function disconnect(kind: string) {
    setNotice(null);
    setProblem(null);
    try {
      await api(`/settings/connectors/${kind}`, { method: "DELETE" });
      setNotice("Disconnected.");
      reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not disconnect.");
    }
  }

  if (!user) return <p className="text-muted">Loading…</p>;
  if (user.role !== "owner") return <Notice tone="bad">Only the owner can change connectors.</Notice>;

  return (
    <div>
      <PageTitle
        kicker="Settings"
        title="Connectors"
        detail="Gmail receives the client’s letter. The Warehance bot looks up the order. Slack shows the draft on the floor."
      />
      {loading ? <p className="text-muted">Loading…</p> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {data ? (
        <div className="grid max-w-3xl gap-4">
          <GmailCard key={data.gmail.detail ?? "gmail"} connector={data.gmail} onSave={(email) => save("/settings/connectors/gmail", { email })} onTest={() => test("gmail")} onDisconnect={() => disconnect("gmail")} />
          <WarehanceCard key={`${data.warehance.address ?? ""}-${data.warehance.detail ?? ""}`} connector={data.warehance} onSave={(url, key) => save("/settings/connectors/warehance", { url, key })} onTest={() => test("warehance")} onDisconnect={() => disconnect("warehance")} />
          <SlackCard key={`${data.slack.label ?? ""}-${data.slack.detail ?? ""}`} connector={data.slack} onSave={(token, channel) => save("/settings/connectors/slack", { token, channel })} onTest={() => test("slack")} onDisconnect={() => disconnect("slack")} />
        </div>
      ) : null}
    </div>
  );
}

function Card({ title, connector, children }: { title: string; connector: Connector; children: React.ReactNode }) {
  return (
    <section className="card space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className={`text-sm ${connector.connected ? "text-moss" : "text-muted"}`}>
          {connector.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      {connector.label ? <p className="text-sm">{connector.label}</p> : null}
      {connector.detail ? <p className="text-sm text-muted">{connector.detail}</p> : null}
      {children}
    </section>
  );
}

function Actions({ onTest, onDisconnect }: { onTest: () => void; onDisconnect: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-primary" type="submit">
        Save
      </button>
      <button className="btn" type="button" onClick={onTest}>
        Test
      </button>
      <button className="btn" type="button" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

function GmailCard({
  connector,
  onSave,
  onTest,
  onDisconnect,
}: {
  connector: Connector;
  onSave: (email: string) => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const [email, setEmail] = useState(connector.label ?? "");
  return (
    <Card title="Gmail" connector={connector}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(email);
        }}
      >
        <Field label="Warehouse mailbox">
          <input className="field" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <p className="text-sm text-muted">This stores the mailbox only. Test does not sign in to Google.</p>
        <Actions onTest={onTest} onDisconnect={onDisconnect} />
      </form>
    </Card>
  );
}

function WarehanceCard({
  connector,
  onSave,
  onTest,
  onDisconnect,
}: {
  connector: Connector;
  onSave: (url: string, key: string) => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const [url, setUrl] = useState(connector.address ?? "");
  const [key, setKey] = useState("");
  return (
    <Card title="Warehance bot" connector={connector}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(url, key);
          setKey("");
        }}
      >
        <Field label="Connector address">
          <input className="field" placeholder="https://your-connector.example/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Field label="Staff key">
          <input className="field" type="password" placeholder={connector.connected ? "Saved. Paste only to replace it." : ""} value={key} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <Actions onTest={onTest} onDisconnect={onDisconnect} />
      </form>
    </Card>
  );
}

function SlackCard({
  connector,
  onSave,
  onTest,
  onDisconnect,
}: {
  connector: Connector;
  onSave: (token: string, channel: string) => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState(connector.label ?? "");
  return (
    <Card title="Slack" connector={connector}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(token, channel);
          setToken("");
        }}
      >
        <Field label="Channel">
          <input className="field" placeholder="#client-mail" value={channel} onChange={(event) => setChannel(event.target.value)} />
        </Field>
        <Field label="Bot token">
          <input className="field" type="password" placeholder={connector.connected ? "Saved. Paste only to replace it." : "xoxb-"} value={token} onChange={(event) => setToken(event.target.value)} />
        </Field>
        <Actions onTest={onTest} onDisconnect={onDisconnect} />
      </form>
    </Card>
  );
}
