import type { ChatPreparedChange, ChatStockChange } from "@opsengine/db";

export type WarehanceAuditEvent = {
  action: "retrieve" | "change";
  tool: string;
  kind: string;
  recordId: string;
  label: string;
  payload: Record<string, unknown>;
  outcome: string;
  error: string | null;
};

const SKIP_TOOLS = new Set(["export_data", "propose_send", "propose_inventory", "propose_change"]);
const RECORD_CAP = 50;
const HIDDEN = /secret|token|password|approval|api[_-]?key/i;

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function idOf(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function textOf(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function slimValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length;
  if (depth > 1 || typeof value !== "object") return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(asObj(value))) {
    if (HIDDEN.test(key)) continue;
    const slim = slimValue(item, depth + 1);
    if (slim !== undefined) next[key] = slim;
  }
  return next;
}

export function slimPayload(value: Record<string, unknown>): Record<string, unknown> {
  return asObj(slimValue(value, 0));
}

function describe(tool: string, raw: Record<string, unknown>): { kind: string; recordId: string; label: string } {
  const record = asObj(raw);
  const nestedOrder = asObj(record.order);
  const nestedProduct = asObj(record.product);
  if (tool === "search_orders" || tool === "get_order") {
    const recordId = idOf(record.id) || idOf(nestedOrder.id);
    const number = textOf({ ...nestedOrder, ...record }, ["order_number", "number"]) || recordId;
    return { kind: "order", recordId, label: number ? `Order ${number}` : "Order" };
  }
  if (tool === "search_shipments") {
    const recordId = idOf(record.id);
    const number = textOf(record, ["tracking_number", "shipment_number"]) || recordId;
    return { kind: "shipment", recordId, label: number ? `Shipment ${number}` : "Shipment" };
  }
  if (tool === "search_products") {
    const recordId = idOf(record.id);
    const sku = textOf(record, ["sku", "name"]) || recordId;
    return { kind: "product", recordId, label: sku ? `Product ${sku}` : "Product" };
  }
  if (tool === "search_inventory_locations") {
    const recordId = idOf(nestedProduct.id) || idOf(record.product_id) || idOf(record.id);
    const sku = textOf({ ...nestedProduct, ...record }, ["sku", "name"]) || recordId;
    return { kind: "inventory", recordId, label: sku ? `Product ${sku}` : "Inventory" };
  }
  if (tool === "search_returns") {
    const recordId = idOf(record.id);
    const number = textOf(record, ["rma_number", "return_number", "order_number"]) || recordId;
    return { kind: "return", recordId, label: number ? `Return ${number}` : "Return" };
  }
  if (tool === "search_inbound_shipments") {
    const recordId = idOf(record.id);
    const number = textOf(record, ["reference_number", "po_number"]) || recordId;
    return { kind: "inbound", recordId, label: number ? `Inbound ${number}` : "Inbound" };
  }
  if (tool === "list_clients" || tool === "search_clients") {
    const recordId = idOf(record.id);
    const name = textOf(record, ["name", "client_name"]) || recordId;
    return { kind: "client", recordId, label: name || "Client" };
  }
  return { kind: "record", recordId: idOf(record.id), label: textOf(record, ["name", "sku", "order_number"]) || tool };
}

export function eventsFromLookup(input: {
  tool: string;
  ok: boolean;
  error: string | null;
  records: Record<string, unknown>[];
  via?: string;
  recordCount?: number;
}): WarehanceAuditEvent[] {
  if (SKIP_TOOLS.has(input.tool) || input.via === "export") return [];
  const count = input.recordCount ?? input.records.length;
  if (!input.ok) {
    return [
      {
        action: "retrieve",
        tool: input.tool,
        kind: "lookup",
        recordId: "",
        label: input.tool,
        payload: { recordCount: count },
        outcome: "failed",
        error: input.error,
      },
    ];
  }
  if (input.records.length === 0) {
    return [
      {
        action: "retrieve",
        tool: input.tool,
        kind: "lookup",
        recordId: "",
        label: `${count} record(s) from ${input.tool}`,
        payload: { recordCount: count, stored: false },
        outcome: "ok",
        error: input.error,
      },
    ];
  }
  return input.records.slice(0, RECORD_CAP).map((record) => {
    const described = describe(input.tool, record);
    return {
      action: "retrieve" as const,
      tool: input.tool,
      kind: described.kind,
      recordId: described.recordId,
      label: described.label,
      payload: slimPayload(record),
      outcome: "ok",
      error: null,
    };
  });
}

export function eventsFromPreparedChange(
  change: Pick<ChatPreparedChange, "kind" | "args" | "summary" | "before" | "result">,
  outcome: string,
  error: string | null,
): WarehanceAuditEvent[] {
  const args = asObj(change.args);
  const recordId = idOf(args.order_id) || idOf(args.product_id) || idOf(args.id);
  return [
    {
      action: "change",
      tool: change.kind,
      kind: change.kind,
      recordId,
      label: change.summary || change.kind,
      payload: {
        args: slimPayload(args),
        before: slimPayload(asObj(change.before)),
        result: slimPayload(asObj(change.result ?? {})),
      },
      outcome,
      error,
    },
  ];
}

export function eventsFromStockChange(change: Pick<ChatStockChange, "clientName" | "warehouse" | "rows">, outcome: string, error: string | null): WarehanceAuditEvent[] {
  const rows = change.rows.length > 0 ? change.rows : [{ sku: "", location: "", warehouse: change.warehouse, qtyBefore: 0, qtyAfter: 0, lotCode: "", ok: null, error }];
  return rows.slice(0, RECORD_CAP).map((row) => ({
    action: "change" as const,
    tool: "adjust_inventory",
    kind: "inventory",
    recordId: row.sku,
    label: row.sku ? `${row.sku} @ ${row.location}` : "Stock change",
    payload: {
      clientName: change.clientName,
      warehouse: row.warehouse || change.warehouse,
      sku: row.sku,
      location: row.location,
      qtyBefore: row.qtyBefore,
      qtyAfter: row.qtyAfter,
      ok: row.ok,
    },
    outcome: row.ok === false ? "rejected" : outcome,
    error: row.error ?? error,
  }));
}
