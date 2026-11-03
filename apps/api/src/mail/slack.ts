type SlackUser = { id: string; name: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };

async function call<T>(token: string, method: string, body: Record<string, unknown> | null, query?: Record<string, string>) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as T & { ok: boolean; error?: string };
}

const ID = /^[UW][A-Z0-9]{6,}$/;

let cache: { at: number; users: SlackUser[] } | null = null;

async function everyone(token: string) {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.users;
  const users: SlackUser[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const reply = await call<{ members?: SlackUser[]; response_metadata?: { next_cursor?: string } }>(
      token,
      "users.list",
      null,
      { limit: "200", ...(cursor ? { cursor } : {}) },
    );
    if (!reply.ok) throw new Error(reply.error === "missing_scope" ? "Slack needs the users:read scope to find people by name." : `Slack: ${reply.error}`);
    users.push(...(reply.members ?? []));
    cursor = reply.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  cache = { at: Date.now(), users };
  return users;
}

// Accepts a Slack member ID, an email address, or a @name. Returns the member ID.
export async function findPerson(token: string, entry: string) {
  const text = entry.trim().replace(/^@/, "");
  if (ID.test(text)) return text;
  if (text.includes("@")) {
    const reply = await call<{ user?: { id: string } }>(token, "users.lookupByEmail", null, { email: text });
    if (reply.ok && reply.user) return reply.user.id;
    if (reply.error === "missing_scope") throw new Error("Slack needs the users:read.email scope to find people by email.");
    throw new Error(`No one in Slack has the email ${text}.`);
  }
  const wanted = text.toLowerCase();
  const found = (await everyone(token)).find((user) =>
    [user.name, user.real_name, user.profile?.display_name, user.profile?.real_name].some((name) => name?.toLowerCase() === wanted),
  );
  if (!found) throw new Error(`No one in Slack is called ${text}.`);
  return found.id;
}

export async function post(token: string, channel: string, text: string) {
  const reply = await call<unknown>(token, "chat.postMessage", { channel, text, link_names: false });
  if (!reply.ok) {
    if (reply.error === "not_in_channel") throw new Error(`The bot is not in ${channel}. Invite it with /invite.`);
    if (reply.error === "channel_not_found") throw new Error(`Slack cannot find ${channel}.`);
    throw new Error(`Slack: ${reply.error}`);
  }
}

// Slack reads <, > and & as markup, so text from an email has them escaped.
export function plain(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
