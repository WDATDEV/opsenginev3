import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveBinFromRecords, rowsFromInput, skusFromInput, type StockRow } from "./stock-change.js";
import { parseAdjustResult } from "./stock-confirm.js";

describe("connector adjust result", () => {
  it("reads applied_quantity and capped from the connector's record", () => {
    assert.deepEqual(parseAdjustResult({ record: { applied_quantity: -5, capped: true, requested_quantity: -6 } }), { appliedQuantity: -5, capped: true });
    assert.deepEqual(parseAdjustResult({ applied_quantity: -6, capped: false }), { appliedQuantity: -6, capped: false });
  });
});

const row: StockRow = {
  sku: "UFOLALOWS2_BLK_EU42", location: "J-08-11-05", warehouse: "Ops Engine",
  qtyBefore: 6, qtyAfter: 0, lotCode: "", ok: null, error: null,
};

// Shape returned by the connector's search_inventory_locations.
const bin = (over: Record<string, unknown> = {}) => ({
  quantity: 6, available: 6, action_locked: 0, damaged: false, lot: null, lpn: null,
  product: { id: 231190679451, sku: "UFOLALOWS2_BLK_EU42", name: "Handmade Sneaker" },
  location: { id: 231185317000, name: "J-08-11-05", warehouse: { id: 231185183344, name: "Ops Engine" } },
  ...over,
});

describe("live bin from connector records", () => {
  it("reads nested product.sku / location.name / location.warehouse.name", () => {
    assert.deepEqual(liveBinFromRecords([bin()], row), { available: 6, onHand: 6 });
  });

  it("still reads flat rows", () => {
    assert.deepEqual(
      liveBinFromRecords([{ sku: row.sku, location: row.location, warehouse: "Ops Engine", quantity: 6, available: 4 }], row),
      { available: 4, onHand: 6 },
    );
  });

  it("does not match another bin, SKU or warehouse", () => {
    assert.equal(liveBinFromRecords([bin({ location: { name: "J-10-09-04", warehouse: { name: "Ops Engine" } } })], row), null);
    assert.equal(liveBinFromRecords([bin({ product: { sku: "UFOLALOWS2_BLK_EU43" } })], row), null);
    assert.equal(liveBinFromRecords([bin({ location: { name: "J-08-11-05", warehouse: { name: "Other WH" } } })], row), null);
  });

  it("ignores stock on an LPN", () => {
    assert.equal(liveBinFromRecords([bin({ lpn: { id: 5, name: "LPN-1" } })], row), null);
    assert.deepEqual(liveBinFromRecords([bin(), bin({ quantity: 9, available: 9, lpn: { id: 5 } })], row), { available: 6, onHand: 6 });
  });
});

describe("card rows from connector records", () => {
  it("builds rows and SKUs from nested records", () => {
    const rows = rowsFromInput([bin()]);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.sku, rows[0]!.location, rows[0]!.warehouse, rows[0]!.qtyBefore], [row.sku, row.location, "Ops Engine", 6]);
    assert.deepEqual(skusFromInput([bin()]), [row.sku]);
  });
});
