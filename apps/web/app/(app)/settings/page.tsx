"use client";

import { useEffect, useState } from "react";
import { api, ApiError, hasSection, post } from "@/lib/api";
import { useSession } from "@/components/shell";
import { Badge, Field, Notice, PageTitle, SkeletonList, useResource } from "@/components/ui";

type Connector = { connected: boolean; label: string | null; detail: string | null; address: string | null; googleReady?: boolean };
type Connectors = { gmail: Connector; warehance: Connector; slack: Connector; anthropic: Connector };

export default function SettingsPage() {
  const user = useSession();
  const allowed = hasSection(user, "settings");
  const { data, error, loading, reload } = useResource<Connectors>(allowed ? "/settings/connectors" : null);
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

  // Google brings the owner back to this page with the result in the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("gmail");
    if (!result) return;
    if (result === "connected") setNotice("Gmail is connected. New mail is checked every minute.");
    else if (result === "denied") setProblem("Google sign-in was cancelled.");
    else setProblem(params.get("reason") ?? "Could not finish the Google sign-in.");
    window.history.replaceState(null, "", "/settings");
  }, []);

  async function connectGmail() {
    setNotice(null);
    setProblem(null);
    try {
      const { url } = await post<{ url: string }>("/settings/connectors/gmail/connect", {});
      window.location.href = url;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not start the Google sign-in.");
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

  if (!user) return <SkeletonList rows={2} />;
  if (!allowed) return <Notice tone="bad">Settings is not turned on for this account.</Notice>;

  return (
    <div>
      <PageTitle
        kicker="Settings"
        title="Connectors"
        detail="Gmail receives the client’s letter. The Warehance bot looks up the order. Claude writes the draft. Slack tells people about it."
      />
      {loading && !data ? <SkeletonList rows={4} /> : null}
      <div className="mb-4 max-w-3xl space-y-3 empty:hidden">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
      </div>
      {data ? (
        <div className="grid max-w-3xl gap-4">
          <GmailCard connector={data.gmail} onConnect={connectGmail} onTest={() => test("gmail")} onDisconnect={() => disconnect("gmail")} />
          <WarehanceCard key={`${data.warehance.address ?? ""}-${data.warehance.detail ?? ""}`} connector={data.warehance} onSave={(url, key) => save("/settings/connectors/warehance", { url, key })} onTest={() => test("warehance")} onDisconnect={() => disconnect("warehance")} />
          <SlackCard key={`${data.slack.label ?? ""}-${data.slack.detail ?? ""}`} connector={data.slack} onSave={(token) => save("/settings/connectors/slack", { token })} onTest={() => test("slack")} onDisconnect={() => disconnect("slack")} />
          <ClaudeCard connector={data.anthropic} onSave={(key) => save("/settings/connectors/anthropic", { key })} onTest={() => test("anthropic")} onDisconnect={() => disconnect("anthropic")} />
        </div>
      ) : null}
    </div>
  );
}

function Card({ title, connector, children }: { title: string; connector: Connector; children: React.ReactNode }) {
  return (
    <section className="card space-y-4 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className={`grid h-10 w-10 flex-none place-items-center rounded-xl text-sm font-bold ${connector.connected ? "bg-moss text-paper" : "bg-black/10 text-muted"}`}>
          {title.charAt(0)}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
        <Badge tone={connector.connected ? "ok" : "neutral"} dot>
          {connector.connected ? "Connected" : "Not connected"}
        </Badge>
      </div>
      {connector.label ? <p className="break-all text-sm font-medium">{connector.label}</p> : null}
      {connector.detail ? <p className="text-sm leading-6 text-muted">{connector.detail}</p> : null}
      {children}
    </section>
  );
}

// Once a connector is saved its key stays hidden. All that is left is Test and Disconnect.
// To change a key, disconnect first and add it again.
function SavedActions({ onTest, onDisconnect }: { onTest: () => void; onDisconnect: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn" type="button" onClick={onTest}>
        Test
      </button>
      <button className="btn btn-danger" type="button" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

function SaveButton() {
  return (
    <button className="btn btn-primary" type="submit">
      Save
    </button>
  );
}

function GmailCard({
  connector,
  onConnect,
  onTest,
  onDisconnect,
}: {
  connector: Connector;
  onConnect: () => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  return (
    <Card title="Gmail" connector={connector}>
      {connector.googleReady === false ? (
        <p className="text-sm text-muted">Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the API first.</p>
      ) : (
        <p className="text-sm text-muted">Sign in as the warehouse mailbox. Ops Engine keeps Google’s token, never the password.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" type="button" disabled={connector.googleReady === false} onClick={onConnect}>
          {connector.connected ? "Sign in again" : "Connect with Google"}
        </button>
        {connector.connected ? (
          <>
            <button className="btn" type="button" onClick={onTest}>
              Test
            </button>
            <button className="btn btn-danger" type="button" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        ) : null}
      </div>
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
  if (connector.connected) {
    return (
      <Card title="Warehance bot" connector={connector}>
        {connector.address ? <p className="break-all text-sm text-muted">{connector.address}</p> : null}
        <SavedActions onTest={onTest} onDisconnect={onDisconnect} />
      </Card>
    );
  }
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
          <input className="field" type="password" value={key} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <SaveButton />
      </form>
    </Card>
  );
}

function ClaudeCard({
  connector,
  onSave,
  onTest,
  onDisconnect,
}: {
  connector: Connector;
  onSave: (key: string) => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const [key, setKey] = useState("");
  if (connector.connected) {
    return (
      <Card title="Claude" connector={connector}>
        <SavedActions onTest={onTest} onDisconnect={onDisconnect} />
      </Card>
    );
  }
  return (
    <Card title="Claude" connector={connector}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(key);
          setKey("");
        }}
      >
        <p className="text-sm text-muted">The Anthropic API key writes the draft replies. It is billed per use and is separate from a Claude subscription.</p>
        <Field label="API key">
          <input className="field" type="password" placeholder="sk-ant-" value={key} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <SaveButton />
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
  onSave: (token: string) => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const [token, setToken] = useState("");
  if (connector.connected) {
    return (
      <Card title="Slack" connector={connector}>
        <SavedActions onTest={onTest} onDisconnect={onDisconnect} />
      </Card>
    );
  }
  return (
    <Card title="Slack" connector={connector}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(token);
          setToken("");
        }}
      >
        <p className="text-sm text-muted">Only the bot token is needed. Each automation rule chooses its own channels or people.</p>
        <Field label="Bot token">
          <input className="field" type="password" placeholder="xoxb-" value={token} onChange={(event) => setToken(event.target.value)} />
        </Field>
        <SaveButton />
      </form>
    </Card>
  );
}
