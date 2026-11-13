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

function norm(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function sameName(left: string, right: string) {
  return norm(left) === norm(right);
}

function freeQty(item: Item) {
  const onHand = qtyOf(item.quantity);
  if (item.available != null && item.available !== "") {
    const available = qtyOf(item.available);
    if (Number.isFinite(available)) return Math.max(0, Math.min(onHand, available));
  }
  const locked = qtyOf(item.action_locked);
  return Math.max(0, onHand - locked);
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
      const hits = await this.inventoryAt(productId, warehouseId, row.location, row.warehouse);
      const live = hits.reduce((sum, item) => sum + qtyOf(item.quantity), 0);
      const free = hits.reduce((sum, item) => sum + freeQty(item), 0);
      if (hits.length === 0) {
        return { ok: false, error: `${row.sku} was not found at ${row.location} in ${row.warehouse}.`, qtyBefore: row.qtyBefore };
      }
      if (live === STOCK_JOB.quantity || free === 0) {
        if (live > STOCK_JOB.quantity && free === 0) {
          return {
            ok: false,
            error: `${row.sku} @ ${row.location} has ${live} on hand but none available (allocated or locked). Warehance will not go negative. Nothing was changed.`,
            qtyBefore: live,
          };
        }
        return { ok: true, error: null, qtyBefore: live };
      }

      for (const item of hits) {
        const take = freeQty(item);
        if (take <= 0) continue;
        const location = asObj(item.location);
        const locationId = idOf(location);
        if (!locationId) return { ok: false, error: `${row.sku} @ ${row.location} has no location id.`, qtyBefore: live };
        const body: Item = {
          product_id: productId,
          location_id: locationId,
          quantity: STOCK_JOB.quantity - take,
          damaged: false,
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
      const message = err instanceof Error ? err.message : "Warehance did not accept that stock change.";
      if (/negative quantity/i.test(message)) {
        return {
          ok: false,
          error: `${row.sku} @ ${row.location} could not go to 0. Some units are allocated or already moved. Ask again so the card shows live quantity, then Confirm. Nothing extra was taken.`,
          qtyBefore: row.qtyBefore,
        };
      }
      return { ok: false, error: message, qtyBefore: row.qtyBefore };
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
    return rows.find((item) => sameName(textOf(item.name), name)) ?? rows.find((item) => norm(textOf(item.name)).includes(norm(name))) ?? null;
  }

  private locationName(item: Item) {
    const loc = asObj(item.location);
    return textOf(loc?.name) || textOf(loc?.code) || textOf(item.location_name);
  }

  private warehouseNameOf(item: Item) {
    const loc = asObj(item.location);
    const warehouse = asObj(loc?.warehouse) ?? asObj(item.warehouse);
    return textOf(warehouse?.name);
  }

  private matchBin(item: Item, location: string, warehouse: string) {
    if (!sameName(this.locationName(item), location)) return false;
    const got = this.warehouseNameOf(item);
    if (!got || !warehouse) return true;
    return sameName(got, warehouse) || norm(got).includes(norm(warehouse));
  }

  private async inventoryAt(productId: number, warehouseId: number | null, location: string, warehouse: string) {
    const tries: Record<string, string>[] = [{ product_id: String(productId), location_name: location, limit: "100" }];
    if (warehouseId) {
      tries.unshift({
        product_id: String(productId),
        warehouse_id: String(warehouseId),
        location_name: location,
        limit: "100",
      });
      tries.push({ product_id: String(productId), warehouse_id: String(warehouseId), limit: "100" });
    }
    tries.push({ product_id: String(productId), limit: "100" });
    tries.push({ location_name: location, limit: "100" });

    const seen = new Set<string>();
    const found: Item[] = [];
    for (const query of tries) {
      const rows = await this.listPages("/inventory-locations", query, "inventory_locations");
      for (const item of rows) {
        if (!this.matchBin(item, location, warehouse)) continue;
        const key = `${idOf(asObj(item.location)) ?? this.locationName(item)}:${idOf(asObj(item.lpn)) ?? 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(item);
      }
      if (found.length > 0) return found;
    }

    const locId = await this.locationId(location, warehouseId);
    if (!locId) return [];
    const byId = await this.listPages("/inventory-locations", { product_id: String(productId), location_id: String(locId), limit: "100" }, "inventory_locations");
    return byId.filter((item) => this.matchBin(item, location, warehouse) || idOf(asObj(item.location)) === locId);
  }

  private async locationId(name: string, warehouseId: number | null) {
    try {
      const query: Record<string, string> = { search_value: name, limit: "100" };
      if (warehouseId) query.warehouse_id = String(warehouseId);
      const rows = await this.listPages("/locations", query, "locations");
      const hit = rows.find((item) => sameName(textOf(item.name), name) || sameName(textOf(item.code), name));
      return idOf(hit);
    } catch {
      return null;
    }
  }

  private async listPages(path: string, query: Record<string, string>, key: string) {
    const out: Item[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page += 1) {
      const payload = await this.get(path, cursor ? { ...query, cursor } : query);
      const rows = listOf(payload, [key]);
      out.push(...rows);
      const root = asObj(payload) ?? {};
      const data = asObj(root.data) ?? root;
      const next = textOf(data.next_cursor ?? root.next_cursor);
      if (!next || rows.length === 0) break;
      cursor = next;
    }
    return out;
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
