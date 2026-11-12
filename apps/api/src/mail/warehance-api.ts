import { STOCK_JOB, type StockRow } from "./stock-change.js";

const BASE = "https://api.warehance.com/v1";

type Item = Record<string, unknown>;

function asObj(value: unknown): Item | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : null;
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return textOf(value[0]);
  const row = asObj(value);
  return row ? textOf(row.name ?? row.sku ?? row.code) : "";
}

function idOf(value: unknown): number | null {
  const row = asObj(value);
  const raw = row ? row.id : value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function qtyOf(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function listOf(payload: unknown, keys: string[]) {
  const root = asObj(payload) ?? {};
  const data = asObj(root.data) ?? root;
  for (const key of keys) {
    const nested = data[key] ?? root[key];
    if (Array.isArray(nested)) return nested.map((item) => asObj(item) ?? {});
  }
  return [] as Item[];
}

function errorOf(payload: unknown, fallback: string) {
  const root = asObj(payload) ?? {};
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const first = asObj(errors[0]);
  const message = textOf(first?.message) || textOf(root.message);
  const suggestion = textOf(first?.suggestion);
  if (message && suggestion) return `${message} ${suggestion}`;
  return message || fallback;
}

export class WarehanceApi {
  constructor(private readonly key: string) {}

  async check() {
    const warehouses = await this.get("/warehouses", { limit: "1" });
    const products = await this.get("/products", { limit: "1" });
    const warehouse = listOf(warehouses, ["warehouses"])[0];
    const product = listOf(products, ["products"])[0];
    const warehouseName = textOf(warehouse?.name) || "a warehouse";
    const sku = textOf(product?.sku) || "a product";
    return `Connected to the Warehance API. Read ${warehouseName} and ${sku}. Confirm uses this key to change stock. Claude never sees it.`;
  }

  async setToZero(row: StockRow, clientId: number | null): Promise<{ ok: boolean; error: string | null; qtyBefore: number }> {
    try {
      const product = await this.product(row.sku, clientId);
      const productId = idOf(product);
      if (!productId) return { ok: false, error: `SKU ${row.sku} was not found in Warehance.`, qtyBefore: row.qtyBefore };

      const warehouse = await this.warehouse(row.warehouse);
      const warehouseId = idOf(warehouse);
      if (!warehouseId) return { ok: false, error: `Warehouse ${row.warehouse} was not found.`, qtyBefore: row.qtyBefore };

      const hits = await this.inventoryAt(productId, warehouseId, row.location);
      const live = hits.reduce((sum, item) => sum + qtyOf(item.quantity), 0);
      if (hits.length === 0) {
        return { ok: false, error: `${row.sku} was not found at ${row.location} in ${row.warehouse}.`, qtyBefore: row.qtyBefore };
      }
      if (live === STOCK_JOB.quantity) return { ok: true, error: null, qtyBefore: live };

      for (const item of hits) {
        const onHand = qtyOf(item.quantity);
        const delta = STOCK_JOB.quantity - onHand;
        if (delta === 0) continue;
        const location = asObj(item.location);
        const locationId = idOf(location);
        if (!locationId) return { ok: false, error: `${row.sku} @ ${row.location} has no location id.`, qtyBefore: live };
        const body: Item = {
          product_id: productId,
          location_id: locationId,
          quantity: delta,
          inventory_adjustment_reason: STOCK_JOB.reason,
          note: STOCK_JOB.reason,
        };
        const lotId = idOf(asObj(item.lot));
        const lpnId = idOf(asObj(item.lpn));
        if (lotId) body.product_lot_id = lotId;
        if (lpnId) body.lpn_id = lpnId;
        await this.post("/inventory/adjust", body);
      }
      return { ok: true, error: null, qtyBefore: live };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Warehance did not accept that stock change.", qtyBefore: row.qtyBefore };
    }
  }

  private async product(sku: string, clientId: number | null) {
    const query: Record<string, string> = { skus: sku, limit: "5" };
    if (clientId) query.client_id = String(clientId);
    const payload = await this.get("/products", query);
    const rows = listOf(payload, ["products"]);
    return rows.find((item) => textOf(item.sku).toLowerCase() === sku.toLowerCase()) ?? rows[0] ?? null;
  }

  private async warehouse(name: string) {
    const payload = await this.get("/warehouses", { search_value: name, limit: "25" });
    const rows = listOf(payload, ["warehouses"]);
    const want = name.trim().toLowerCase();
    return rows.find((item) => textOf(item.name).toLowerCase() === want) ?? null;
  }

  private async inventoryAt(productId: number, warehouseId: number, location: string) {
    const want = location.trim().toLowerCase();
    const named = listOf(
      await this.get("/inventory-locations", {
        product_id: String(productId),
        warehouse_id: String(warehouseId),
        location_name: location,
        limit: "100",
      }),
      ["inventory_locations"],
    );
    const namedHits = named.filter((item) => textOf(asObj(item.location)?.name).toLowerCase() === want);
    if (namedHits.length > 0) return namedHits;
    const all = listOf(
      await this.get("/inventory-locations", {
        product_id: String(productId),
        warehouse_id: String(warehouseId),
        limit: "100",
      }),
      ["inventory_locations"],
    );
    return all.filter((item) => textOf(asObj(item.location)?.name).toLowerCase() === want);
  }

  private async get(path: string, query: Record<string, string>) {
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return this.send(url, { method: "GET" });
  }

  private async post(path: string, body: Item) {
    return this.send(new URL(`${BASE}${path}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async send(url: URL, init: RequestInit) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          "X-API-KEY": this.key,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Could not reach the Warehance API.");
    }
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("The Warehance API key was rejected.");
    if (res.status === 403) {
      throw new Error(
        errorOf(payload, "The Warehance API key cannot write inventory. Give it read_products, read_warehouses, read_inventory, and write_inventory."),
      );
    }
    if (!res.ok) throw new Error(errorOf(payload, `Warehance answered ${res.status}.`));
    const status = textOf(asObj(payload)?.status).toLowerCase();
    if (status === "error") throw new Error(errorOf(payload, "Warehance did not accept that request."));
    return payload;
  }
}
