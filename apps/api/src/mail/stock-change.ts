import type { McpTool } from "./warehance-client.js";

export const STOCK_JOB = {
  clientName: "tempostorm",
  skuPrefix: "UFO",
  warehouse: "Ops Engine",
  action: "set" as const,
  quantity: 0,
  reason: "Ops Engine Chat zero",
  ttlMs: 15 * 60_000,
};

export function stockRowCap() {
  const n = Number(process.env.STOCK_CHANGE_MAX_ROWS ?? "1");
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 1;
}

export type StockRow = {
  sku: string;
  location: string;
  warehouse: string;
  qtyBefore: number;
  qtyAfter: number;
  lotCode: string;
  ok: boolean | null;
  error: string | null;
};

export type StockChange = {
  logId: string | null;
  clientName: string;
  clientId: number | null;
  warehouse: string;
  action: "set";
  quantity: number;
  reason: string;
  skuPrefix: string;
  rows: StockRow[];
  status: "proposed" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  note: string | null;
};

const WRITE_NAME = /\b(create|update|delete|adjust|import|upsert|patch|remove|insert|write|mutate|set_)\b/i;

export function isWriteTool(name: string, description = "") {
  const lower = name.toLowerCase();
  if (/^(search|list|get|find|read|lookup|fetch|count|show)_/.test(lower)) return false;
  if (lower.startsWith("list") || lower.startsWith("search") || lower.startsWith("get_")) return false;
  return WRITE_NAME.test(`${name} ${description}`);
}

export function pickLocationLookupTool(tools: McpTool[]) {
  const reads = tools.filter((tool) => !isWriteTool(tool.name, tool.description));
  const prefer = [
    "search_inventory_locations",
    "list_inventory_locations",
    "get_inventory_locations",
    "search_inventory",
    "list_inventory",
    "get_product_inventory",
    "search_products",
  ];
  for (const name of prefer) {
    const hit = reads.find((tool) => tool.name === name);
    if (hit) return hit;
  }
  return (
    reads.find((tool) => /inventory/i.test(tool.name) && /location/i.test(`${tool.name} ${tool.description ?? ""}`)) ??
    reads.find((tool) => /inventory/i.test(tool.name)) ??
    null
  );
}

export function argsForLocationLookup(tool: McpTool, sku: string, clientId: number | null) {
  const props = Object.keys((tool.inputSchema?.properties ?? {}) as Record<string, unknown>);
  const want: Record<string, string | number> = {
    sku,
    product_sku: sku,
    query: sku,
    search: sku,
    sku_prefix: STOCK_JOB.skuPrefix,
    warehouse: STOCK_JOB.warehouse,
    warehouse_name: STOCK_JOB.warehouse,
    limit: 100,
  };
  if (clientId) want.client_id = clientId;
  const args: Record<string, unknown> = {};
  for (const prop of props) {
    const key = prop.toLowerCase();
    if (key in want) args[prop] = want[key];
  }
  if (props.length === 0) {
    args.sku = sku;
    args.warehouse = STOCK_JOB.warehouse;
    args.limit = 100;
    if (clientId) args.client_id = clientId;
  }
  return args;
}

export function pickApplyTool(tools: McpTool[]) {
  const ranked = tools
    .filter((tool) => isWriteTool(tool.name, tool.description))
    .filter((tool) => /inventory|location|stock|on_hand|quantity/i.test(`${tool.name} ${tool.description ?? ""}`));
  const prefer = ["import_inventory_locations", "update_inventory_location", "set_inventory", "adjust_inventory", "update_inventory"];
  for (const name of prefer) {
    const hit = ranked.find((tool) => tool.name === name);
    if (hit) return hit;
  }
  return ranked[0] ?? null;
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return textOf(row.name ?? row.code ?? row.location_name ?? row.bin ?? row.label ?? row.barcode ?? row.warehouse_name);
  }
  return "";
}

function field(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const direct = textOf(record[name]);
    if (direct) return direct;
    const key = Object.keys(record).find((item) => {
      const lower = item.toLowerCase();
      return lower === name.toLowerCase() || lower.endsWith(`_${name}`) || lower === name.replace("_", "");
    });
    if (key) {
      const nested = textOf(record[key]);
      if (nested) return nested;
    }
  }
  return "";
}

function qtyOf(record: Record<string, unknown>) {
  const raw = field(record, ["quantity_on_hand", "qty_on_hand", "on_hand", "quantity", "qty", "available"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function flattenRecords(input: unknown): Record<string, unknown>[] {
  const list = Array.isArray(input) ? input : [];
  const out: Record<string, unknown>[] = [];
  for (const item of list) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const nested = record.inventory_locations ?? record.locations ?? record.bins ?? record.inventory;
    if (Array.isArray(nested) && nested.length > 0) {
      for (const loc of nested) {
        const piece: Record<string, unknown> = loc && typeof loc === "object" ? (loc as Record<string, unknown>) : { location: loc };
        out.push({ ...record, ...piece, sku: record.sku ?? record.product_sku ?? piece.sku, location: piece.location ?? piece });
      }
    } else {
      out.push(record);
    }
  }
  return out;
}

export function skusFromInput(input: unknown): string[] {
  const seen = new Set<string>();
  for (const record of flattenRecords(input)) {
    const sku = field(record, ["sku", "product_sku"]);
    if (sku && sku.toLowerCase().startsWith(STOCK_JOB.skuPrefix.toLowerCase())) seen.add(sku);
  }
  return [...seen];
}

function warehouseName(value: string) {
  const v = value.trim();
  if (!v || /^\d+$/.test(v)) return STOCK_JOB.warehouse;
  if (v.toLowerCase() === STOCK_JOB.warehouse.toLowerCase()) return STOCK_JOB.warehouse;
  return v;
}

export function rowsFromInput(input: unknown): StockRow[] {
  const rows: StockRow[] = [];
  for (const record of flattenRecords(input)) {
    const sku = field(record, ["sku", "product_sku"]);
    const location = field(record, ["location", "location_name", "bin", "location_code", "shelf"]);
    const warehouse = warehouseName(field(record, ["warehouse", "warehouse_name"]) || STOCK_JOB.warehouse);
    const lotCode = field(record, ["lot_code", "lot"]);
    if (!sku || !location) continue;
    if (/^\d+$/.test(location) && location === field(record, ["warehouse"])) continue;
    rows.push({
      sku,
      location,
      warehouse,
      qtyBefore: qtyOf(record),
      qtyAfter: STOCK_JOB.quantity,
      lotCode,
      ok: null,
      error: null,
    });
  }
  return rows;
}

export function filterJobRows(rows: StockRow[], clientName: string) {
  const clientOk = clientName.trim().toLowerCase() === STOCK_JOB.clientName;
  const prefix = STOCK_JOB.skuPrefix.toLowerCase();
  const warehouse = STOCK_JOB.warehouse.toLowerCase();
  const seen = new Set<string>();
  const kept: StockRow[] = [];
  const dropped: string[] = [];
  if (!clientOk) return { kept, dropped: ["Client must be Tempostorm."] };
  for (const row of rows) {
    if (!row.sku.toLowerCase().startsWith(prefix)) {
      dropped.push(`${row.sku} is not a UFO SKU.`);
      continue;
    }
    const wh = warehouseName(row.warehouse).toLowerCase();
    if (wh !== warehouse) {
      dropped.push(`${row.sku} is not in warehouse Ops Engine.`);
      continue;
    }
    const key = `${row.sku.toLowerCase()}|${row.location.toLowerCase()}`;
    if (seen.has(key)) {
      dropped.push(`${row.sku} @ ${row.location} is duplicated.`);
      continue;
    }
    seen.add(key);
    kept.push({ ...row, warehouse: STOCK_JOB.warehouse, qtyAfter: STOCK_JOB.quantity });
  }
  return { kept, dropped };
}

export function argsForApply(tool: McpTool, row: StockRow, clientId: number | null) {
  const props = Object.keys((tool.inputSchema?.properties ?? {}) as Record<string, unknown>);
  const want: Record<string, string | number> = {
    sku: row.sku,
    product_sku: row.sku,
    location: row.location,
    location_name: row.location,
    bin: row.location,
    warehouse: row.warehouse,
    warehouse_name: row.warehouse,
    quantity: STOCK_JOB.quantity,
    qty: STOCK_JOB.quantity,
    on_hand: STOCK_JOB.quantity,
    action: STOCK_JOB.action,
    adjustment_reason: STOCK_JOB.reason,
    reason: STOCK_JOB.reason,
    lot_code: row.lotCode,
    lot: row.lotCode,
  };
  if (clientId) {
    want.client_id = clientId;
  }
  const args: Record<string, unknown> = {};
  for (const prop of props) {
    const key = prop.toLowerCase();
    if (key in want && want[key] !== "") args[prop] = want[key];
  }
  if (!("sku" in args) && props.length === 0) {
    args.sku = row.sku;
    args.location = row.location;
    args.warehouse = row.warehouse;
    args.quantity = STOCK_JOB.quantity;
    args.action = STOCK_JOB.action;
    args.adjustment_reason = STOCK_JOB.reason;
    if (row.lotCode) args.lot_code = row.lotCode;
    if (clientId) args.client_id = clientId;
  }
  return args;
}
