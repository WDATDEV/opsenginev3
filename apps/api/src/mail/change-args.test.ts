import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChangeArgs } from "./change-args.js";

describe("propose_change validation", () => {
  it("refuses unknown kind, unknown field, wrong type, empty update, and tags with add_tags", () => {
    assert.equal(parseChangeArgs("delete_warehouse", { order_id: 1 }).ok, false);
    assert.equal(parseChangeArgs("update_order", { order_id: 1, extra: true }).ok, false);
    assert.equal(parseChangeArgs("update_order", { order_id: "1" }).ok, false);
    assert.equal(parseChangeArgs("update_order", { order_id: 1 }).ok, false);
    assert.equal(parseChangeArgs("update_product", { product_id: 1, tags: ["a"], add_tags: ["b"] }).ok, false);
  });

  it("accepts a valid cancel and a signed inventory adjust", () => {
    const cancel = parseChangeArgs("cancel_order", { order_id: 44 });
    assert.equal(cancel.ok, true);
    if (cancel.ok) assert.equal(cancel.args.order_id, 44);
    const adjust = parseChangeArgs("adjust_inventory", {
      sku: "X",
      location_name: "A-1",
      warehouse: "Main",
      quantity: -2,
    });
    assert.equal(adjust.ok, true);
  });
});
