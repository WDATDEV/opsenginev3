export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
};

type RpcReply = { result?: unknown; error?: { message?: string } };

// The connector answers each POST with plain JSON. Some MCP servers answer with an event stream instead, so both are read.
async function readReply(res: Response): Promise<RpcReply> {
  const raw = await res.text();
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .pop();
    return data ? (JSON.parse(data) as RpcReply) : {};
  }
  return raw ? (JSON.parse(raw) as RpcReply) : {};
}

function endpoint(url: string) {
  const parsed = new URL(url);
  return parsed.pathname.endsWith("/mcp") ? parsed.toString() : new URL("/mcp", parsed.origin).toString();
}

// Turns a bad HTTP status into a sentence that says what to fix.
async function explain(url: string, res: Response) {
  const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
  if (res.status === 401) return "The Warehance connector rejected the staff key.";
  if (res.status === 403) return "The connector refused the request (403). On the connector, PUBLIC_HOSTNAME must be set to this domain.";
  if (res.status === 404) {
    // The bot answers /health when it is running. That tells a wrong address from a wrong path.
    const health = await fetch(new URL("/health", new URL(url).origin), { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const running = health?.ok && (await health.text().catch(() => "")).includes('"ok"');
    return running
      ? "The connector is running, but nothing is at that path. Use the address that ends in /mcp."
      : `Nothing at that address is the Warehance connector (404${snippet ? `: ${snippet}` : ""}). Check the connector's public domain in Railway and that its deploy is running.`;
  }
  return `The Warehance connector answered ${res.status}${snippet ? `: ${snippet}` : "."}`;
}

async function rpc(url: string, key: string, id: number, method: string, params: unknown): Promise<RpcReply> {
  const res = await fetch(endpoint(url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(await explain(url, res));
  const reply = await readReply(res);
  if (reply.error) throw new Error(reply.error.message ?? "The Warehance connector returned an error.");
  return reply;
}

export class WarehanceClient {
  private next = 1;

  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  async listTools(): Promise<McpTool[]> {
    await rpc(this.url, this.key, this.next++, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ops-engine", version: "0.0.1" },
    });
    const reply = await rpc(this.url, this.key, this.next++, "tools/list", {});
    return ((reply.result as { tools?: McpTool[] } | undefined)?.tools ?? []) as McpTool[];
  }

  // The settings test: sign in, list the tools, then read one real record, the way Claude would.
  async check(): Promise<string> {
    const tools = (await this.listTools()).map((tool) => tool.name);
    if (tools.length === 0) throw new Error("The connector signed in but offers no tools for this key.");

    const probe = tools.includes("list_clients")
      ? { name: "list_clients", args: { limit: 1 }, label: "client" }
      : tools.includes("search_orders")
        ? { name: "search_orders", args: { limit: 1 }, label: "order" }
        : null;
    if (!probe) return `Connected. ${tools.length} tool(s) available. No simple lookup was available to read a record.`;

    const { data, failed } = await this.call(probe.name, probe.args);
    if (failed) {
      const reason = (data as { error?: string } | undefined)?.error;
      throw new Error(`Signed in, but ${probe.name} failed${reason ? `: ${reason}` : "."}`);
    }
    const records = ((data as { records?: Record<string, unknown>[] } | undefined)?.records ?? []) as Record<string, unknown>[];
    const first = records[0];
    const name = first && (first.name ?? first.order_number ?? first.id);
    return `Connected. ${tools.length} tools available. Read ${records.length} ${probe.label} record(s) from Warehance${name ? `, for example ${String(name)}` : ""}.`;
  }

  // Returns what the tool printed. The connector prints JSON, so it is parsed when possible.
  async call(name: string, args: Record<string, unknown>): Promise<{ data: unknown; failed: boolean }> {
    const reply = await rpc(this.url, this.key, this.next++, "tools/call", { name, arguments: args });
    const result = reply.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    const text = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep the plain text */
    }
    return { data, failed: Boolean(result?.isError) };
  }
}
