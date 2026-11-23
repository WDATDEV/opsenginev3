import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addLookupLinks, placeLinks, type WarehanceLink } from "./warehance-links.js";

type Page = Parameters<typeof addLookupLinks>[1][number];
const bookOf = (...pages: Page[]) => addLookupLinks(new Map<string, WarehanceLink>(), pages);
const place = (content: string, ...pages: Page[]) => placeLinks(content, bookOf(...pages).values());
const named = (content: string, link: { start: number; end: number }) => content.slice(link.start, link.end);

describe("Warehance chat links", () => {
  it("links an order named with its ID", () => {
    const text = "1 order shipped. It was order FL-Test (ID: 231224052240), on November 21.";
    const [link, ...rest] = place(text, { tool: "search_orders", ok: true, records: [{ id: 231224052240, order_number: "FL-Test", status: "shipped" }] });
    assert.equal(rest.length, 0);
    assert.equal(link?.href, "https://app.warehance.com/orders/231224052240");
    assert.equal(named(text, link!), "(ID: 231224052240)");
    assert.deepEqual(link?.details, [{ label: "Status", value: "shipped" }]);
  });

  it("links both the order and tracking number from a shipment lookup", () => {
    const text = "Order FL-Test (ID: 55) shipped via UPS with tracking number 1Z19E1K54215069592.";
    const links = place(text, { tool: "search_shipments", ok: true, records: [{ id: 9, tracking_number: "1Z19E1K54215069592", carrier: "UPS", order: { id: 55, order_number: "FL-Test" } }] });
    assert.deepEqual(links.map((link) => link.href), ["https://app.warehance.com/orders/55", "https://app.warehance.com/shipments/9"]);
    assert.equal(named(text, links[1]!), "1Z19E1K54215069592");
    assert.deepEqual(links[1]?.details[1], { label: "Carrier", value: "UPS" });
  });

  it("links a name without the ID, in any letter case", () => {
    const text = "Order fl-test is on hold.";
    const links = place(text, { tool: "get_order", records: [{ id: 2, order_number: "FL-Test" }] });
    assert.equal(links.length, 1);
    assert.equal(named(text, links[0]!), "fl-test");
  });

  it("does not link part of a longer name or number", () => {
    const pages: Page = { tool: "search_orders", records: [{ id: 123, order_number: "FL-1" }] };
    assert.equal(place("See FL-12 and ID 91234.", pages).length, 0);
  });

  it("gives the longer SKU the icon when one SKU starts with another", () => {
    const text = "Stock for UFO-1-BLK is low.";
    const links = place(text, { tool: "search_products", records: [{ id: 1, sku: "UFO-1" }, { id: 2, sku: "UFO-1-BLK" }] });
    assert.deepEqual(links.map((link) => link.href), ["https://app.warehance.com/products/2"]);
  });

  it("opens a nested product on an inventory row and skips failed pages", () => {
    const links = place(
      "ABC is in stock. NOPE is not.",
      { tool: "search_inventory_locations", ok: true, records: [{ product: { id: 3, sku: "ABC" }, location_name: "A-1" }] },
      { tool: "search_orders", ok: false, records: [{ id: 1, order_number: "NOPE" }] },
    );
    assert.equal(links.length, 1);
    assert.equal(links[0]?.href, "https://app.warehance.com/products/3");
  });

  it("keeps links on a follow-up reply about the same record", () => {
    const book = bookOf({ tool: "search_orders", ok: true, records: [{ id: 8, order_number: "HG-100" }] });
    assert.equal(placeLinks("HG-100 is packed.", book.values()).length, 1);
    assert.equal(placeLinks("Anything else?", book.values()).length, 0);
    assert.equal(placeLinks("HG-100 shipped too.", book.values()).length, 1);
  });

  it("skips bulk export pages", () => {
    assert.equal(place("ABC", { tool: "search_products", ok: true, records: [{ id: 3, sku: "ABC" }], args: { __via: "export" } }).length, 0);
  });

  it("keeps full order details when a shipment later names the same order", () => {
    const book = bookOf(
      { tool: "get_order", records: [{ id: 7, order_number: "HG-7", status: "shipped" }] },
      { tool: "search_shipments", records: [{ id: 9, order: { id: 7, order_number: "HG-7" } }] },
    );
    assert.deepEqual(book.get("https://app.warehance.com/orders/7")?.details, [{ label: "Status", value: "shipped" }]);
  });

  it("does not put address or contact details in the preview", () => {
    const [link] = place("HG-9", { tool: "get_order", records: [{ id: 9, order_number: "HG-9", email: "a@example.test", phone: "555", ship_to: { name: "A Person" }, status: "open" }] });
    assert.deepEqual(link?.details, [{ label: "Status", value: "open" }]);
  });
});
