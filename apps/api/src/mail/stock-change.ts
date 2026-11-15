import type { McpTool } from "./warehance-client.js";

export const STOCK_JOB = {
  clientName: "AI Testing Client",
  skuPrefix: "",
  action: "set" as const,
  reason: "Ops Engine Chat",
  ttlMs: 15 * 60_000,
};

export function allowedStockClient(name: string | null | undefined) {
  return name?.trim().toLowerCase() === STOCK_JOB.clientName.toLowerCase();
}

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
  appliedQuantity?: number | null;
  capped?: boolean | null;
  nonce?: string | null;
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
  status: "proposed" | "applying" | "applied" | "rejected";
  proposedAt: string;
  expiresAt: string;
  note: string | null;
};

export function pickLocationLookupTool(tools: McpTool[]) {
  return tools.find((tool) => tool.name === "search_inventory_locations") ?? null;
}

export function argsForLocationLookup(tool: McpTool, sku: string, clientId: number | null, warehouse?: string) {
  const props = Object.keys((tool.inputSchema?.properties ?? {}) as Record<string, unknown>);
  const want: Record<string, string | number> = {
    sku,
    product_sku: sku,
    query: sku,
    search: sku,
    limit: 100,
  };
  if (warehouse) {
    want.warehouse = warehouse;
    want.warehouse_name = warehouse;
  }
  if (clientId) want.client_id = clientId;
  const args: Record<string, unknown> = {};
  for (const prop of props) {
    const key = prop.toLowerCase();
    if (key in want) args[prop] = want[key];
  }
  if (props.length === 0) {
    args.sku = sku;
    args.limit = 100;
    if (warehouse) args.warehouse = warehouse;
    if (clientId) args.client_id = clientId;
  }
  return args;
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

// The connector returns bins nested: product.sku, location.name, location.warehouse.name.
// Read those first, then fall back to flat names (sku, location, warehouse) for rows Claude writes.
function pathText(record: Record<string, unknown>, path: string) {
  let cur: unknown = record;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return "";
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" || typeof cur === "number" ? String(cur).trim() : "";
}

function skuOf(record: Record<string, unknown>) {
  return pathText(record, "product.sku") || field(record, ["sku", "product_sku"]);
}

function locationOf(record: Record<string, unknown>, names = ["location", "location_name", "bin", "location_code"]) {
  return pathText(record, "location.name") || field(record, names);
}

function warehouseOf(record: Record<string, unknown>) {
  return pathText(record, "location.warehouse.name") || field(record, ["warehouse", "warehouse_name"]);
}

function qtyOf(record: Record<string, unknown>) {
  const raw = field(record, ["quantity_on_hand", "qty_on_hand", "on_hand", "quantity", "qty", "available"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function numberField(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
    if (!key) continue;
    const raw = record[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function liveBinFromRecords(raw: unknown, row: StockRow): { available: number; onHand: number } | null {
  const hits = flattenRecords(raw).filter((record) => {
    // Stock on an LPN (license plate) can't be adjusted by the connector, so it isn't counted.
    if (record.lpn) return false;
    const sku = skuOf(record);
    const location = locationOf(record);
    const warehouse = warehouseOf(record);
    if (sku.toLowerCase() !== row.sku.toLowerCase()) return false;
    if (location.toLowerCase() !== row.location.toLowerCase()) return false;
    if (warehouse && row.warehouse && warehouse.toLowerCase() !== row.warehouse.toLowerCase()) return false;
    return true;
  });
  if (hits.length === 0) return null;
  let available = 0;
  let onHand = 0;
  for (const record of hits) {
    const free = numberField(record, ["available", "quantity_available", "qty_available"]);
    const hand = numberField(record, ["quantity_on_hand", "on_hand", "qty_on_hand", "quantity", "qty"]);
    if (free == null || hand == null) return null;
    available += free;
    onHand += hand;
  }
  return { available, onHand };
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
    const sku = skuOf(record);
    if (sku) seen.add(sku);
  }
  return [...seen];
}

function warehouseName(value: string) {
  const v = value.trim();
  if (!v || /^\d+$/.test(v)) return "";
  return v;
}

function qtyAfterOf(record: Record<string, unknown>, qtyBefore: number) {
  const set = numberField(record, ["qty_after", "qtyAfter", "set_quantity", "target_quantity", "quantity_after"]);
  if (set != null) return set;
  const quantity = numberField(record, ["quantity", "qty"]);
  if (quantity != null) return quantity;
  return qtyBefore;
}

export function rowsFromInput(input: unknown): StockRow[] {
  const rows: StockRow[] = [];
  for (const record of flattenRecords(input)) {
    const sku = skuOf(record);
    const location = locationOf(record, ["location", "location_name", "bin", "location_code", "shelf"]);
    const warehouse = warehouseName(warehouseOf(record));
    const lotCode = field(record, ["lot_code", "lot"]);
    if (!sku || !location) continue;
    if (/^\d+$/.test(location) && location === field(record, ["warehouse"])) continue;
    const qtyBefore = qtyOf(record);
    rows.push({
      sku,
      location,
      warehouse,
      qtyBefore,
      qtyAfter: qtyAfterOf(record, qtyBefore),
      lotCode,
      ok: null,
      error: null,
    });
  }
  return rows;
}

export function filterJobRows(rows: StockRow[], clientName: string) {
  const seen = new Set<string>();
  const kept: StockRow[] = [];
  const dropped: string[] = [];
  if (!allowedStockClient(clientName)) return { kept, dropped: ["Stock changes are only allowed for AI Testing Client."] };
  for (const row of rows) {
    if (!row.sku.trim() || !row.location.trim()) {
      dropped.push("Each row needs a SKU and a location.");
      continue;
    }
    if (!Number.isFinite(row.qtyAfter) || row.qtyAfter < 0 || !Number.isInteger(row.qtyAfter)) {
      dropped.push(`${row.sku} needs a whole-number quantity to set (0 or more).`);
      continue;
    }
    const key = `${row.sku.toLowerCase()}|${row.location.toLowerCase()}|${row.warehouse.toLowerCase()}`;
    if (seen.has(key)) {
      dropped.push(`${row.sku} @ ${row.location} is duplicated.`);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { kept, dropped };
}
