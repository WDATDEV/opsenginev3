const DEFAULT_APP = "https://app.warehance.com";
const LINK_CAP = 25;

export type WarehanceLink = { href: string; label: string; kind: string };

function appOrigin() {
  const raw = (process.env.WAREHANCE_APP_URL ?? DEFAULT_APP).trim().replace(/\/+$/, "");
  return raw || DEFAULT_APP;
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

function labelOf(record: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function linkFor(tool: string, raw: Record<string, unknown>): WarehanceLink | null {
  const record = asObj(raw);
  const nestedOrder = asObj(record.order);
  const nestedProduct = asObj(record.product);
  const origin = appOrigin();

  if (tool === "search_orders" || tool === "get_order") {
    const id = idOf(record.id) ?? idOf(nestedOrder.id);
    if (!id) return null;
    const number = labelOf({ ...nestedOrder, ...record }, ["order_number", "number"], id);
    return { kind: "order", href: `${origin}/orders/${id}`, label: `Order ${number}` };
  }
  if (tool === "search_shipments") {
    const id = idOf(record.id);
    if (!id) return null;
    const number = labelOf(record, ["tracking_number", "shipment_number"], id);
    return { kind: "shipment", href: `${origin}/shipments/${id}`, label: `Shipment ${number}` };
  }
  if (tool === "search_products") {
    const id = idOf(record.id);
    if (!id) return null;
    const sku = labelOf(record, ["sku", "name"], id);
    return { kind: "product", href: `${origin}/products/${id}`, label: `Product ${sku}` };
  }
  if (tool === "search_inventory_locations") {
    const id = idOf(nestedProduct.id) ?? idOf(record.product_id);
    if (!id) return null;
    const sku = labelOf({ ...nestedProduct, ...record }, ["sku", "name"], id);
    return { kind: "product", href: `${origin}/products/${id}`, label: `Product ${sku}` };
  }
  if (tool === "search_returns") {
    const id = idOf(record.id);
    if (!id) return null;
    const number = labelOf(record, ["rma_number", "return_number", "order_number"], id);
    return { kind: "return", href: `${origin}/returns/${id}`, label: `Return ${number}` };
  }
  if (tool === "search_inbound_shipments") {
    const id = idOf(record.id);
    if (!id) return null;
    const number = labelOf(record, ["reference_number", "po_number"], id);
    return { kind: "inbound", href: `${origin}/inbound-shipments/${id}`, label: `Inbound ${number}` };
  }
  return null;
}

export function linksFromLookups(
  pages: { tool: string; ok?: boolean; records?: Record<string, unknown>[]; args?: Record<string, unknown> }[],
): WarehanceLink[] {
  const out: WarehanceLink[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (page.ok === false) continue;
    if (asObj(page.args).__via === "export") continue;
    for (const record of page.records ?? []) {
      const link = linkFor(page.tool, record);
      if (!link || seen.has(link.href)) continue;
      seen.add(link.href);
      out.push(link);
      if (out.length >= LINK_CAP) return out;
    }
  }
  return out;
}

const SKIP_TOOLS = new Set(["export_data", "propose_send", "propose_inventory", "propose_change"]);

export function linksForMessage(
  messageId: string,
  lookups: { tool: string }[],
  logs: { messageId: string; tool: string; ok?: boolean; records?: Record<string, unknown>[]; args?: Record<string, unknown> }[],
  already: Set<string>,
): WarehanceLink[] {
  const tools = new Set(lookups.map((item) => item.tool).filter((tool) => !SKIP_TOOLS.has(tool)));
  if (tools.size === 0) return [];
  const mine = logs.filter((log) => String(log.messageId) === String(messageId) && tools.has(log.tool));
  const links = linksFromLookups(mine).filter((link) => !already.has(link.href));
  for (const link of links) already.add(link.href);
  return links;
}
