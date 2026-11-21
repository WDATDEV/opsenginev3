import { randomUUID } from "node:crypto";
import { APPROVAL_TTL_SECONDS, canonicalChange, signChangeApproval } from "./approval.js";
import { parseChangeArgs, type ChangeKind } from "./change-args.js";
import { liveBinFromRecords, pickLocationLookupTool, argsForLocationLookup, STOCK_JOB } from "./stock-change.js";
import { callFailure, connectorRefusal, redactSensitive, SETUP_ERROR, writeSetup } from "./stock-confirm.js";
import { hasClientLabel, labelledForAnotherClient, TEST_CLIENT_ERROR, toolFiltersByClient } from "./test-client.js";
import type { WarehanceClient } from "./warehance-client.js";

export const CHANGE_TTL_MS = STOCK_JOB.ttlMs;
export const STALE_CARD = "Changed since the card was made. Ask again.";

export type ChatChange = {
  kind: ChangeKind;
  args: Record<string, unknown>;
  summary: string;
  before: Record<string, unknown>;
  status: "proposed" | "applying" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  result: Record<string, unknown> | null;
  error: string | null;
};

export type WriteCall = { name: string; args: Record<string, unknown> };

type ThreadScope = { warehanceClientId: number | null; warehanceClientName: string | null };

export function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function recordsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  const body = asObj(data);
  if (Array.isArray(body.records)) return body.records.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  if (body.record && typeof body.record === "object") return [asObj(body.record)];
  if (Object.keys(body).length > 0 && !("error" in body)) return [body];
  return [];
}

function snapshotJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

function isInventoryKind(kind: ChangeKind) {
  return kind === "adjust_inventory" || kind === "move_inventory";
}

export async function prepareChangeCard(
  input: { kind?: string; args?: unknown; summary?: string },
  thread: ThreadScope,
  write: WarehanceClient,
  testClientId: number,
): Promise<{ ok: true; card: ChatChange } | { ok: false; error: string }> {
  if (thread.warehanceClientId !== testClientId) return { ok: false, error: TEST_CLIENT_ERROR };
  const parsed = parseChangeArgs(String(input.kind ?? ""), input.args ?? {});
  if (!parsed.ok) return parsed;
  const args = { ...parsed.args };
  if (args.client_id != null && args.client_id !== testClientId) return { ok: false, error: TEST_CLIENT_ERROR };
  if (isInventoryKind(parsed.kind)) args.client_id = testClientId;
  const snapped = await snapshotTarget(parsed.kind, args, testClientId, write);
  if (!snapped.ok) return snapped;
  const now = new Date();
  return {
    ok: true,
    card: {
      kind: parsed.kind,
      args,
      summary: String(input.summary ?? "").trim().slice(0, 400),
      before: snapped.before,
      status: "proposed",
      proposedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHANGE_TTL_MS).toISOString(),
      result: null,
      error: null,
    },
  };
}

async function snapshotTarget(
  kind: ChangeKind,
  args: Record<string, unknown>,
  clientId: number,
  write: WarehanceClient,
): Promise<{ ok: true; before: Record<string, unknown> } | { ok: false; error: string }> {
  if (isInventoryKind(kind)) return snapshotInventory(kind, args, clientId, write);
  if (kind === "update_product") return snapshotProduct(args, clientId, write);
  return snapshotOrder(kind, args, clientId, write);
}

async function snapshotInventory(
  kind: ChangeKind,
  args: Record<string, unknown>,
  clientId: number,
  write: WarehanceClient,
) {
  const sku = String(args.sku);
  const tools = await write.listTools();
  const tool = pickLocationLookupTool(tools);
  if (!tool) return { ok: false as const, error: "The write key cannot search inventory locations." };
  if (!toolFiltersByClient(tools, tool.name)) return { ok: false as const, error: TEST_CLIENT_ERROR };
  const locations =
    kind === "move_inventory"
      ? [String(args.from_location_name), String(args.to_location_name)]
      : [String(args.location_name)];
  const bins: Record<string, unknown>[] = [];
  for (const location of locations) {
    const lookupArgs = argsForLocationLookup(tool, sku, clientId, String(args.warehouse ?? ""));
    lookupArgs.location_name = location;
    if (args.warehouse) lookupArgs.warehouse = args.warehouse;
    const { data, failed } = await write.call(tool.name, lookupArgs);
    if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that bin." };
    const records = recordsOf(data);
    if (records.some((record) => labelledForAnotherClient(record, clientId))) {
      return { ok: false as const, error: TEST_CLIENT_ERROR };
    }
    const live = liveBinFromRecords(records, {
      sku,
      location,
      warehouse: String(args.warehouse ?? ""),
      qtyBefore: 0,
      qtyAfter: 0,
      lotCode: "",
      ok: null,
      error: null,
    });
    bins.push({ location, quantity: live?.onHand ?? null, available: live?.available ?? null });
  }
  return { ok: true as const, before: { sku, warehouse: args.warehouse, bins } };
}

async function snapshotProduct(args: Record<string, unknown>, clientId: number, write: WarehanceClient) {
  const productId = Number(args.product_id);
  if (!toolFiltersByClient(await write.listTools(), "search_products")) return { ok: false as const, error: TEST_CLIENT_ERROR };
  const { data, failed } = await write.call("search_products", { limit: 50, client_id: clientId });
  if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that product." };
  const record = recordsOf(data).find((item) => Number(item.id) === productId);
  if (!record) return { ok: false as const, error: "That product was not found." };
  if (labelledForAnotherClient(record, clientId)) return { ok: false as const, error: TEST_CLIENT_ERROR };
  return {
    ok: true as const,
    before: pick(record, ["id", "name", "barcode", "product_note", "pack_note", "return_note", "weight", "length", "width", "height", "reserve_amount", "replenishment_level", "archived", "tags"]),
  };
}

async function snapshotOrder(kind: ChangeKind, args: Record<string, unknown>, clientId: number, write: WarehanceClient) {
  if (kind === "update_order" || kind === "cancel_order") {
    const orderId = Number(args.order_id);
    const { data, failed } = await write.call("get_order", { order_id: orderId });
    if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that order." };
    const record = recordsOf(data)[0];
    if (!record) return { ok: false as const, error: "That order was not found." };
    if (labelledForAnotherClient(record, clientId)) return { ok: false as const, error: TEST_CLIENT_ERROR };
    // get_order has no client filter, so an unlabelled order must also appear in this client's search.
    if (!hasClientLabel(record)) {
      const owned = await orderInClientSearch(write, orderId, clientId);
      if (!owned.ok) return owned;
    }
    return { ok: true as const, before: orderBefore(record) };
  }
  const itemId = Number(args.order_item_id);
  const found = await findOrderItem(write, itemId, clientId);
  if (!found.ok) return found;
  if (labelledForAnotherClient(found.order, clientId)) return { ok: false as const, error: TEST_CLIENT_ERROR };
  return {
    ok: true as const,
    before: {
      order_id: found.order.id,
      cancelled: found.order.cancelled ?? found.order.status,
      item: pick(found.item, ["id", "quantity", "quantity_shipped", "cancelled"]),
    },
  };
}

async function orderInClientSearch(write: WarehanceClient, orderId: number, clientId: number) {
  if (!toolFiltersByClient(await write.listTools(), "search_orders")) return { ok: false as const, error: TEST_CLIENT_ERROR };
  const args: Record<string, unknown> = { limit: 50, client_id: clientId };
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    if (cursor) args.cursor = cursor;
    const { data, failed } = await write.call("search_orders", args);
    if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that order." };
    const records = recordsOf(data);
    if (records.some((order) => Number(order.id) === orderId && !labelledForAnotherClient(order, clientId))) return { ok: true as const };
    const next = asObj(data).next_cursor;
    cursor = typeof next === "string" ? next : undefined;
    if (!cursor) break;
  }
  return { ok: false as const, error: TEST_CLIENT_ERROR };
}

async function findOrderItem(write: WarehanceClient, itemId: number, clientId: number) {
  if (!toolFiltersByClient(await write.listTools(), "search_orders")) return { ok: false as const, error: TEST_CLIENT_ERROR };
  const args: Record<string, unknown> = { limit: 50, client_id: clientId };
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    if (cursor) args.cursor = cursor;
    const { data, failed } = await write.call("search_orders", args);
    if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that order item." };
    const body = asObj(data);
    for (const order of recordsOf(data)) {
      const items = Array.isArray(order.order_items) ? order.order_items : [];
      const item = items.find((row) => Number(asObj(row).id) === itemId);
      if (item) return { ok: true as const, order, item: asObj(item) };
    }
    cursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
    if (!cursor) break;
  }
  return { ok: false as const, error: "That order item was not found." };
}

function orderBefore(record: Record<string, unknown>) {
  return pick(record, [
    "id",
    "cancelled",
    "status",
    "fulfillment_status",
    "address_hold",
    "payment_hold",
    "warehouse_hold",
    "allocation_hold",
    "fraud_hold",
    "custom_hold_ids",
    "hold_until_date",
    "required_ship_date",
    "packing_note",
    "gift_note",
    "internal_note",
    "delivery_instructions",
    "tags",
    "order_items",
  ]);
}

function pick(record: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) out[key] = record[key];
  }
  return out;
}

export async function rereadMatches(card: ChatChange, thread: ThreadScope, write: WarehanceClient, testClientId: number) {
  if (thread.warehanceClientId !== testClientId) return { ok: false as const, error: TEST_CLIENT_ERROR };
  if (isInventoryKind(card.kind) ? card.args.client_id !== testClientId : card.args.client_id != null) {
    return { ok: false as const, error: TEST_CLIENT_ERROR };
  }
  const now = await snapshotTarget(card.kind, card.args, testClientId, write);
  if (!now.ok) return { ok: false as const, error: now.error };
  if (snapshotJson(now.before) !== snapshotJson(card.before)) return { ok: false as const, error: STALE_CARD };
  return { ok: true as const };
}

export async function applyChangeCard(
  card: ChatChange,
  meta: { approvedBy: string; secret: string },
  write: WarehanceClient,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  uuid = () => randomUUID(),
): Promise<{ card: ChatChange; calls: WriteCall[]; nonce: string | null }> {
  const approved_at = nowSeconds();
  const nonce = uuid();
  const change = canonicalChange(card.args);
  const { approval } = signChangeApproval(
    { tool: card.kind, change, approved_by: meta.approvedBy, approved_at, exp: approved_at + APPROVAL_TTL_SECONDS, nonce },
    meta.secret,
  );
  const args: Record<string, unknown> = { ...change, approval };
  try {
    const { data, failed } = await write.call(card.kind, args);
    const calls = [{ name: card.kind, args }];
    if (failed) {
      return {
        card: { ...card, status: "rejected", error: redactSensitive(connectorRefusal(data), [approval, meta.secret]), result: null },
        calls,
        nonce,
      };
    }
    const record = asObj(asObj(data).record).id != null || Object.keys(asObj(asObj(data).record)).length > 0 ? asObj(asObj(data).record) : asObj(data);
    return { card: { ...card, status: "applied", error: null, result: record }, calls, nonce };
  } catch (err) {
    return {
      card: { ...card, status: "rejected", error: redactSensitive(callFailure(err), [approval, meta.secret]), result: null },
      calls: [{ name: card.kind, args }],
      nonce,
    };
  }
}

export async function writeReady(database: Parameters<typeof writeSetup>[0]) {
  return writeSetup(database);
}

export { SETUP_ERROR };
