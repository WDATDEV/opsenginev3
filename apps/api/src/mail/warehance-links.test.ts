import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linksFromLookups } from "./warehance-links.js";

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
});
