import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linksForMessage, linksFromLookups } from "./warehance-links.js";

describe("Warehance chat links", () => {
  it("builds order and shipment links from lookup records", () => {
    const links = linksFromLookups([
      { tool: "search_orders", ok: true, records: [{ id: 88, order_number: "HG-1001" }] },
      { tool: "search_shipments", ok: true, records: [{ id: 9, tracking_number: "1Z999" }] },
    ]);
    assert.deepEqual(links, [
      { kind: "order", href: "https://app.warehance.com/orders/88", label: "Order HG-1001" },
      { kind: "shipment", href: "https://app.warehance.com/shipments/9", label: "Shipment 1Z999" },
    ]);
  });

  it("opens a nested product on an inventory row and skips failed pages", () => {
    const links = linksFromLookups([
      { tool: "search_inventory_locations", ok: true, records: [{ product: { id: 3, sku: "ABC" } }] },
      { tool: "search_orders", ok: false, records: [{ id: 1, order_number: "NOPE" }] },
    ]);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.href, "https://app.warehance.com/products/3");
  });

  it("does not repeat the same record", () => {
    const links = linksFromLookups([
      { tool: "get_order", records: [{ id: 2, order_number: "A" }] },
      { tool: "search_orders", records: [{ id: 2, order_number: "A" }] },
    ]);
    assert.equal(links.length, 1);
  });

  it("skips bulk export pages and later replies that reuse the same records", () => {
    const logs = [
      { messageId: "m1", tool: "search_products", ok: true, records: [{ id: 3, sku: "ABC" }], args: { __via: "export" } },
      { messageId: "m1", tool: "search_orders", ok: true, records: [{ id: 8, order_number: "HG-1" }] },
      { messageId: "m2", tool: "search_orders", ok: true, records: [{ id: 8, order_number: "HG-1" }] },
    ];
    const already = new Set<string>();
    const first = linksForMessage("m1", [{ tool: "search_orders" }, { tool: "export_data" }], logs, already);
    const second = linksForMessage("m2", [{ tool: "search_orders" }], logs, already);
    const exported = linksForMessage("m1", [{ tool: "export_data" }], logs, new Set());
    assert.deepEqual(
      first.map((link) => link.label),
      ["Order HG-1"],
    );
    assert.equal(second.length, 0);
    assert.equal(exported.length, 0);
  });
});
