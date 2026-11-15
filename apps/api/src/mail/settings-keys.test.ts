import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOT_WRITE_ERROR, KEYS_SAME_ERROR, refuseSameKeys, refuseStaffKey, refuseWriteKey } from "./settings-keys.js";

describe("settings keys", () => {
  it("refuses to save a bot key that can write, and refuses matching bot and write keys", () => {
    assert.equal(
      refuseStaffKey([
        { name: "search_orders", annotations: { readOnlyHint: true } },
        { name: "adjust_inventory", annotations: { readOnlyHint: false } },
      ]),
      BOT_WRITE_ERROR,
    );
    assert.equal(refuseSameKeys("same-secret", "same-secret"), KEYS_SAME_ERROR);
    assert.equal(refuseSameKeys("bot", "write"), null);
    assert.ok(refuseWriteKey([{ name: "search_orders" }]));
    assert.ok(refuseWriteKey([{ name: "adjust_inventory" }]));
    assert.equal(refuseWriteKey([{ name: "adjust_inventory" }, { name: "get_order" }]), null);
  });
});
