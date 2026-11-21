import { connectors } from "@opsengine/db";
import { asObj, LIST_PAGE_CAP, LIST_PAGE_SIZE, listPageArgs, nextListPage, recordsOf } from "../clients/warehance-pages.js";
import { allowedStockClient } from "./stock-change.js";
import { WarehanceClient, type McpTool } from "./warehance-client.js";

export const TEST_CLIENT_ERROR = "Edits are only allowed in a chat set to AI Testing Client. Nothing was changed.";
export const TEST_CLIENT_UNVERIFIED = "Could not confirm AI Testing Client in Warehance, so nothing was changed.";

// Reads the client list from Warehance. Returns an ID only when exactly one client has the test name
// and the whole list was read, so a partial or ambiguous answer can never unlock an edit.
export async function findTestClientId(client: Pick<WarehanceClient, "call">): Promise<number | null> {
  const matches = new Set<number>();
  const seen = new Set<number>();
  let cursor: string | undefined;
  let offset = 0;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const { data, failed } = await client.call("list_clients", listPageArgs(LIST_PAGE_SIZE, cursor, offset));
    if (failed) return null;
    const records = recordsOf(data);
    let added = 0;
    for (const item of records) {
      const raw = asObj(item);
      const id = Number(raw.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      added += 1;
      if (allowedStockClient(String(raw.name ?? raw.company_name ?? ""))) matches.add(id);
    }
    const next = nextListPage(data, records.length, LIST_PAGE_SIZE, offset);
    if (!next || added === 0) return matches.size === 1 ? [...matches][0]! : null;
    cursor = next.cursor;
    offset = next.offset ?? offset + records.length;
  }
  return null;
}

export async function verifiedTestClient(
  database: { select: () => { from: (table: typeof connectors) => unknown } },
  thread: { warehanceClientId: number | null },
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (thread.warehanceClientId == null) return { ok: false, error: TEST_CLIENT_ERROR };
  try {
    const rows = (await database.select().from(connectors)) as { kind: string; secret: string | null; extra: string | null }[];
    const bot = rows.find((row) => row.kind === "warehance");
    if (!bot?.secret || !bot.extra) return { ok: false, error: TEST_CLIENT_UNVERIFIED };
    const id = await findTestClientId(new WarehanceClient(bot.extra, bot.secret));
    if (id == null) return { ok: false, error: TEST_CLIENT_UNVERIFIED };
    return id === thread.warehanceClientId ? { ok: true, id } : { ok: false, error: TEST_CLIENT_ERROR };
  } catch {
    return { ok: false, error: TEST_CLIENT_UNVERIFIED };
  }
}

export function toolFiltersByClient(tools: McpTool[], name: string) {
  const tool = tools.find((item) => item.name === name);
  return Boolean(tool && "client_id" in ((tool.inputSchema?.properties ?? {}) as Record<string, unknown>));
}

function clientLabels(record: Record<string, unknown>) {
  const product = asObj(record.product);
  const ids = [asObj(record.client).id, record.client_id, asObj(product.client).id, product.client_id]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(Number);
  const names = [asObj(record.client).name, record.client_name, asObj(product.client).name, product.client_name]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  return { ids, names };
}

export function hasClientLabel(record: Record<string, unknown>) {
  const { ids, names } = clientLabels(record);
  return ids.length > 0 || names.length > 0;
}

export function labelledForAnotherClient(record: Record<string, unknown>, clientId: number) {
  const { ids, names } = clientLabels(record);
  return ids.some((id) => id !== clientId) || names.some((name) => !allowedStockClient(name));
}
