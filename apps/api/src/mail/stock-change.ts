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

function field(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const direct = record[name];
    if (direct != null && String(direct).trim()) return String(direct).trim();
    const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase() || item.toLowerCase().endsWith(`_${name}`));
    if (key && record[key] != null && String(record[key]).trim()) return String(record[key]).trim();
  }
  return "";
}

function qtyOf(record: Record<string, unknown>) {
  const raw = field(record, ["quantity_on_hand", "qty_on_hand", "on_hand", "quantity", "qty", "available"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function rowsFromInput(input: unknown): StockRow[] {
  const list = Array.isArray(input) ? input : [];
  const rows: StockRow[] = [];
  for (const item of list) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const sku = field(record, ["sku", "product_sku"]);
    const location = field(record, ["location", "location_name", "bin"]);
    const warehouse = field(record, ["warehouse", "warehouse_name"]) || STOCK_JOB.warehouse;
    const lotCode = field(record, ["lot_code", "lot"]);
    if (!sku || !location) continue;
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
    if (row.warehouse.trim().toLowerCase() !== warehouse) {
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
