const DEFAULT_APP = "https://app.warehance.com";
const LINK_CAP = 25;
const MIN_MATCH = 3;
const MAX_DETAILS = 5;

export type LinkDetail = { label: string; value: string };

export type WarehanceLink = {
  href: string;
  label: string;
  kind: string;
  // Short facts from the lookup. Warehance cannot be shown inside another site, so these fill the preview.
  details: LinkDetail[];
  // The words in a reply that name this record, best first.
  match: string[];
};

export type PlacedLink = Omit<WarehanceLink, "match"> & { start: number; end: number };

type LookupPage = { tool: string; ok?: boolean | null; records?: Record<string, unknown>[] | null; args?: unknown };

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

function valueOf(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    const name = asObj(value).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

function detailsOf(record: Record<string, unknown>, fields: [string, string[]][]) {
  const out: LinkDetail[] = [];
  for (const [label, keys] of fields) {
    const value = valueOf(record, keys);
    if (!value) continue;
    out.push({ label, value: /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value.slice(0, 80) });
    if (out.length >= MAX_DETAILS) break;
  }
  return out;
}

function build(kind: string, path: string, name: string, id: string, value: string | null, details: LinkDetail[]): WarehanceLink {
  const match = [`(ID: ${id})`, `ID: ${id}`, ...(value ? [value] : []), id].filter((item) => item.length >= MIN_MATCH);
  return { kind, href: `${appOrigin()}/${path}/${id}`, label: `${name} ${value ?? id}`, details, match };
}

const ORDER_FIELDS: [string, string[]][] = [
  ["Status", ["status", "order_status"]],
  ["Fulfillment", ["fulfillment_status"]],
  ["Ordered", ["order_date", "ordered_at", "created_at"]],
  ["Shipped", ["shipped_at", "ship_date"]],
];

function orderLink(record: Record<string, unknown>) {
  const id = idOf(record.id);
  if (!id) return null;
  return build("order", "orders", "Order", id, valueOf(record, ["order_number", "number"]), detailsOf(record, ORDER_FIELDS));
}

function linksFor(tool: string, raw: Record<string, unknown>): WarehanceLink[] {
  const record = asObj(raw);
  const nestedOrder = asObj(record.order);
  const nestedProduct = asObj(record.product);

  if (tool === "search_orders" || tool === "get_order") {
    const link = orderLink(idOf(record.id) ? { ...nestedOrder, ...record } : nestedOrder);
    return link ? [link] : [];
  }
  if (tool === "search_shipments") {
    const out: WarehanceLink[] = [];
    const id = idOf(record.id);
    if (id) {
      const details = detailsOf(record, [
        ["Tracking", ["tracking_number"]],
        ["Carrier", ["carrier", "carrier_name"]],
        ["Method", ["shipping_method", "service", "service_level"]],
        ["Status", ["status"]],
        ["Shipped", ["shipped_at", "ship_date", "created_at"]],
      ]);
      out.push(build("shipment", "shipments", "Shipment", id, valueOf(record, ["tracking_number", "shipment_number"]), details));
    }
    // A shipment answer usually names its order, so that name gets a link too.
    const order = orderLink({
      ...nestedOrder,
      id: nestedOrder.id ?? record.order_id,
      order_number: nestedOrder.order_number ?? record.order_number,
    });
    if (order) out.push(order);
    return out;
  }
  if (tool === "search_products" || tool === "search_inventory_locations") {
    const product = tool === "search_products" ? record : { ...nestedProduct, ...record };
    const id = tool === "search_products" ? idOf(record.id) : idOf(nestedProduct.id) ?? idOf(record.product_id);
    if (!id) return [];
    const details = detailsOf(product, [
      ["SKU", ["sku"]],
      ["Name", ["name", "product_name"]],
      ["Location", ["location_name", "location"]],
      ["On hand", ["on_hand", "quantity", "qty"]],
      ["Available", ["available", "available_quantity"]],
    ]);
    return [build("product", "products", "Product", id, valueOf(product, ["sku"]), details)];
  }
  if (tool === "search_returns") {
    const id = idOf(record.id);
    if (!id) return [];
    const details = detailsOf(record, [
      ["Status", ["status"]],
      ["Order", ["order_number"]],
      ["Created", ["created_at"]],
    ]);
    return [build("return", "returns", "Return", id, valueOf(record, ["rma_number", "return_number", "order_number"]), details)];
  }
  if (tool === "search_inbound_shipments") {
    const id = idOf(record.id);
    if (!id) return [];
    const details = detailsOf(record, [
      ["Status", ["status"]],
      ["Expected", ["expected_date", "expected_at", "arrival_date"]],
      ["Created", ["created_at"]],
    ]);
    return [build("inbound", "inbound-shipments", "Inbound", id, valueOf(record, ["reference_number", "po_number"]), details)];
  }
  return [];
}

/** Adds each looked-up record to a chat's list, so a later reply about the same record still links. */
export function addLookupLinks(book: Map<string, WarehanceLink>, pages: LookupPage[]) {
  for (const page of pages) {
    if (page.ok === false) continue;
    if (asObj(page.args).__via === "export") continue;
    for (const record of page.records ?? []) {
      for (const link of linksFor(page.tool, record)) {
        const known = book.get(link.href);
        // The fuller copy wins. A shipment's small order stub must not replace a real order lookup.
        if (!known || link.details.length >= known.details.length) book.set(link.href, link);
      }
    }
  }
  return book;
}

const isWordChar = (char: string | undefined) => Boolean(char && /[a-z0-9]/i.test(char));

function firstMention(text: string, lower: string, needle: string) {
  const wanted = needle.toLowerCase();
  let at = lower.indexOf(wanted);
  while (at >= 0) {
    const end = at + wanted.length;
    // "FL-1" must not match inside "FL-12", and an ID must not match inside a longer number.
    const clearBefore = !isWordChar(needle[0]) || !isWordChar(text[at - 1]);
    const clearAfter = !isWordChar(needle[needle.length - 1]) || !isWordChar(text[end]);
    if (clearBefore && clearAfter) return { start: at, end };
    at = lower.indexOf(wanted, at + 1);
  }
  return null;
}

/** Finds where a reply names each record. Only records it actually names get an icon. */
export function placeLinks(content: string, links: Iterable<WarehanceLink>): PlacedLink[] {
  if (!content) return [];
  const lower = content.toLowerCase();
  const found = [...links]
    .map((link) => ({
      link,
      spots: link.match.flatMap((needle) => {
        const spot = firstMention(content, lower, needle);
        return spot ? [spot] : [];
      }),
    }))
    .filter((row) => row.spots.length > 0)
    .sort((a, b) => b.spots[0]!.end - b.spots[0]!.start - (a.spots[0]!.end - a.spots[0]!.start));
  const placed: PlacedLink[] = [];
  for (const { link, spots } of found) {
    const spot = spots.find((row) => !placed.some((item) => row.start < item.end && item.start < row.end));
    if (!spot) continue;
    const { match: _match, ...shown } = link;
    placed.push({ ...shown, ...spot });
    if (placed.length >= LINK_CAP) break;
  }
  return placed.sort((a, b) => a.start - b.start);
}
