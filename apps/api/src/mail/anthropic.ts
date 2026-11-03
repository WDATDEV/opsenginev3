export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type Message = { role: "user" | "assistant"; content: string | Block[] };

export type ClaudeTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type ClaudeReply = { content: Block[]; stop_reason: string | null };

// Model names can be changed on the API without a code change.
export function modelFor(choice: "haiku" | "sonnet") {
  return choice === "sonnet"
    ? (process.env.ANTHROPIC_MODEL_SONNET ?? "claude-sonnet-4-5")
    : (process.env.ANTHROPIC_MODEL_HAIKU ?? "claude-haiku-4-5");
}

const HEADERS = (key: string) => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

export async function ask(
  key: string,
  input: { model: string; system: string; messages: Message[]; tools: ClaudeTool[]; maxTokens?: number },
): Promise<ClaudeReply> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: HEADERS(key),
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 2000,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) throw new Error("Anthropic rejected the API key.");
  if (res.status === 429) throw new Error("Anthropic is rate limiting this key. Try again shortly.");
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      /* no body */
    }
    throw new Error(`Anthropic answered ${res.status}${detail ? `: ${detail}` : "."}`);
  }
  return (await res.json()) as ClaudeReply;
}

// Reads the model record. It costs nothing, so it is the key test.
export async function checkKey(key: string, model: string) {
  const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
    headers: HEADERS(key),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error("Anthropic rejected the API key.");
  if (res.status === 404) throw new Error(`The key works, but the model ${model} was not found. Set ANTHROPIC_MODEL_HAIKU to a model your account has.`);
  if (!res.ok) throw new Error(`Anthropic answered ${res.status}.`);
}
