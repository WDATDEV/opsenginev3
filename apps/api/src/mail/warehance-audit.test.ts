import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventsFromLookup, eventsFromPreparedChange, eventsFromStockChange, slimPayload } from "./warehance-audit.js";

describe("Warehance chat audit", () => {
  it("keeps retrieved orders and skips export dumps", () => {
    const retrieved = eventsFromLookup({
      tool: "search_orders",
      ok: true,
      error: null,
      records: [{ id: 8, order_number: "HG-1", secret: "nope" }],
    });
    const exported = eventsFromLookup({
      tool: "search_products",
      ok: true,
      error: null,
      records: [{ id: 3, sku: "ABC" }],
      via: "export",
    });
    assert.equal(retrieved.length, 1);
    assert.equal(retrieved[0]?.action, "retrieve");
    assert.equal(retrieved[0]?.label, "Order HG-1");
    assert.equal(retrieved[0]?.payload.secret, undefined);
    assert.equal(exported.length, 0);
  });

  it("records a failed lookup and a confirmed stock change", () => {
    const failed = eventsFromLookup({ tool: "get_order", ok: false, error: "not found", records: [] });
    const changed = eventsFromStockChange(
      {
        clientName: "AI Testing Client",
        warehouse: "Main",
        rows: [{ sku: "ABC", location: "A-1", warehouse: "Main", qtyBefore: 4, qtyAfter: 2, lotCode: "", ok: true, error: null }],
      },
      "applied",
      null,
    );
    assert.equal(failed[0]?.outcome, "failed");
    assert.equal(changed[0]?.action, "change");
    assert.equal(changed[0]?.label, "ABC @ A-1");
    assert.equal(changed[0]?.outcome, "applied");
  });

  it("stores a confirmed order change without secrets", () => {
    const events = eventsFromPreparedChange(
      {
        kind: "cancel_order",
        args: { order_id: 8, approval: "hide-me" },
        summary: "Cancel HG-1",
        before: { id: 8, order_number: "HG-1" },
        result: { ok: true },
      },
      "applied",
      null,
    );
    assert.equal(events[0]?.recordId, "8");
    assert.equal(asArgs(events[0]?.payload).approval, undefined);
    assert.deepEqual(slimPayload({ token: "x", name: "ok" }), { name: "ok" });
  });
});

function asArgs(payload: Record<string, unknown> | undefined) {
  const args = payload?.args;
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}
