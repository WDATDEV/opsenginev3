import { randomUUID } from "node:crypto";
import { APPROVAL_TTL_SECONDS, canonicalChange, signChangeApproval } from "./approval.js";
import { parseChangeArgs, type ChangeKind } from "./change-args.js";
import { allowedStockClient, liveBinFromRecords, pickLocationLookupTool, argsForLocationLookup, STOCK_JOB } from "./stock-change.js";
import { callFailure, connectorRefusal, redactSensitive, SETUP_ERROR, writeSetup } from "./stock-confirm.js";
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

function clientOf(record: Record<string, unknown>) {
  const nested = asObj(record.client);
  const id = Number(nested.id ?? record.client_id);
  const name = typeof nested.name === "string" ? nested.name : typeof record.client_name === "string" ? record.client_name : "";
  return { id: Number.isInteger(id) && id > 0 ? id : null, name };
}

export function clientAllowed(record: Record<string, unknown>, thread: ThreadScope) {
  const owner = clientOf(record);
  if (thread.warehanceClientId != null && owner.id != null && owner.id !== thread.warehanceClientId) return false;
  const name = owner.name || thread.warehanceClientName || "";
  return allowedStockClient(name);
}

function snapshotJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

export async function prepareChangeCard(
  input: { kind?: string; args?: unknown; summary?: string },
  thread: ThreadScope,
  write: WarehanceClient,
): Promise<{ ok: true; card: ChatChange } | { ok: false; error: string }> {
  if (thread.warehanceClientName && !allowedStockClient(thread.warehanceClientName)) {
    return { ok: false, error: "Stock changes are only allowed for AI Testing Client." };
  }
  const parsed = parseChangeArgs(String(input.kind ?? ""), input.args ?? {});
  if (!parsed.ok) return parsed;
  const args = { ...parsed.args };
  if ((parsed.kind === "adjust_inventory" || parsed.kind === "move_inventory") && thread.warehanceClientId != null && args.client_id == null) {
    args.client_id = thread.warehanceClientId;
  }
  const snapped = await snapshotTarget(parsed.kind, args, thread, write);
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
  thread: ThreadScope,
  write: WarehanceClient,
): Promise<{ ok: true; before: Record<string, unknown> } | { ok: false; error: string }> {
  if (kind === "adjust_inventory" || kind === "move_inventory") return snapshotInventory(kind, args, thread, write);
  if (kind === "update_product") return snapshotProduct(args, thread, write);
  return snapshotOrder(kind, args, thread, write);
}

async function snapshotInventory(
  kind: ChangeKind,
  args: Record<string, unknown>,
  thread: ThreadScope,
  write: WarehanceClient,
) {
  const sku = String(args.sku);
  const clientId = typeof args.client_id === "number" ? args.client_id : thread.warehanceClientId;
  const tools = await write.listTools();
  const tool = pickLocationLookupTool(tools);
  if (!tool) return { ok: false as const, error: "The write key cannot search inventory locations." };
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
    const first = records[0] ?? {};
    if (!clientAllowed(productClient(first), thread) && !clientAllowed(first, thread)) {
      return { ok: false as const, error: "Stock changes are only allowed for AI Testing Client." };
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

function productClient(record: Record<string, unknown>) {
  const product = asObj(record.product);
  return { client: asObj(product.client).id != null ? product.client : record.client, client_id: record.client_id, client_name: record.client_name };
}

async function snapshotProduct(args: Record<string, unknown>, thread: ThreadScope, write: WarehanceClient) {
  const productId = Number(args.product_id);
  const { data, failed } = await write.call("search_products", { limit: 50, ...(thread.warehanceClientId ? { client_id: thread.warehanceClientId } : {}) });
  if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that product." };
  const record = recordsOf(data).find((item) => Number(item.id) === productId);
  if (!record) return { ok: false as const, error: "That product was not found." };
  if (!clientAllowed(record, thread)) return { ok: false as const, error: "Stock changes are only allowed for AI Testing Client." };
  return {
    ok: true as const,
    before: pick(record, ["id", "name", "barcode", "product_note", "pack_note", "return_note", "weight", "length", "width", "height", "reserve_amount", "replenishment_level", "archived", "tags"]),
  };
}

async function snapshotOrder(kind: ChangeKind, args: Record<string, unknown>, thread: ThreadScope, write: WarehanceClient) {
  if (kind === "update_order" || kind === "cancel_order") {
    const orderId = Number(args.order_id);
    const { data, failed } = await write.call("get_order", { order_id: orderId });
    if (failed) return { ok: false as const, error: typeof data === "string" ? data : "Could not read that order." };
    const record = recordsOf(data)[0];
    if (!record) return { ok: false as const, error: "That order was not found." };
    if (!clientAllowed(record, thread)) return { ok: false as const, error: "Stock changes are only allowed for AI Testing Client." };
    return { ok: true as const, before: orderBefore(record) };
  }
  const itemId = Number(args.order_item_id);
  const found = await findOrderItem(write, itemId, thread);
  if (!found.ok) return found;
  if (!clientAllowed(found.order, thread)) return { ok: false as const, error: "Stock changes are only allowed for AI Testing Client." };
  return {
    ok: true as const,
    before: {
      order_id: found.order.id,
      cancelled: found.order.cancelled ?? found.order.status,
      item: pick(found.item, ["id", "quantity", "quantity_shipped", "cancelled"]),
    },
  };
}

async function findOrderItem(write: WarehanceClient, itemId: number, thread: ThreadScope) {
  const args: Record<string, unknown> = { limit: 50 };
  if (thread.warehanceClientId) args.client_id = thread.warehanceClientId;
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

export async function rereadMatches(card: ChatChange, thread: ThreadScope, write: WarehanceClient) {
  const now = await snapshotTarget(card.kind, card.args, thread, write);
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
