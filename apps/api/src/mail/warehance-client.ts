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
  if (res.status === 401) throw new Error("The Warehance connector rejected the staff key.");
  if (!res.ok) throw new Error(`The Warehance connector answered ${res.status}.`);
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
