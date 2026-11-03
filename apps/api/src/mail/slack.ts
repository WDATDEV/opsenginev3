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

const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

// Turns what a person typed into a Slack conversation ID: a channel ID, a #channel name, or a person
// (member ID, email or @name), who gets a direct message.
export async function conversationFor(token: string, target: string) {
  const text = target.trim();
  if (!text) throw new Error("Choose where to send it in Slack.");
  if (CHANNEL_ID.test(text)) return text;
  if (!text.startsWith("#")) {
    const person = await findPerson(token, text);
    const opened = await call<{ channel?: { id: string } }>(token, "conversations.open", { users: person });
    if (!opened.ok || !opened.channel) {
      throw new Error(opened.error === "missing_scope" ? "Slack needs the im:write scope to send direct messages." : `Slack: ${opened.error}`);
    }
    return opened.channel.id;
  }
  const wanted = text.slice(1).toLowerCase();
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const reply = await call<{ channels?: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } }>(
      token,
      "conversations.list",
      null,
      { limit: "200", types: "public_channel,private_channel", exclude_archived: "true", ...(cursor ? { cursor } : {}) },
    );
    if (!reply.ok) {
      throw new Error(reply.error === "missing_scope" ? "Slack needs the channels:read scope to find a channel by name." : `Slack: ${reply.error}`);
    }
    const found = (reply.channels ?? []).find((channel) => channel.name.toLowerCase() === wanted);
    if (found) return found.id;
    cursor = reply.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  throw new Error(`Slack cannot find ${text}. The bot may need to be invited to it.`);
}

// Uploads a file into a conversation with a message above it.
export async function uploadFile(
  token: string,
  conversation: string,
  file: { name: string; data: Buffer },
  comment: string,
) {
  const slot = await call<{ upload_url?: string; file_id?: string }>(token, "files.getUploadURLExternal", null, {
    filename: file.name,
    length: String(file.data.length),
  });
  if (!slot.ok || !slot.upload_url || !slot.file_id) {
    throw new Error(slot.error === "missing_scope" ? "Slack needs the files:write scope to upload files." : `Slack: ${slot.error}`);
  }
  const sent = await fetch(slot.upload_url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(file.data),
    signal: AbortSignal.timeout(60_000),
  });
  if (!sent.ok) throw new Error(`Slack did not accept the file (${sent.status}).`);

  const done = await call<unknown>(token, "files.completeUploadExternal", {
    files: [{ id: slot.file_id, title: file.name }],
    channel_id: conversation,
    ...(comment ? { initial_comment: comment } : {}),
  });
  if (!done.ok) {
    if (done.error === "not_in_channel" || done.error === "channel_not_found") {
      throw new Error("The bot is not in that channel. Invite it with /invite.");
    }
    throw new Error(`Slack: ${done.error}`);
  }
}

// Slack reads <, > and & as markup, so text from an email has them escaped.
export function plain(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
