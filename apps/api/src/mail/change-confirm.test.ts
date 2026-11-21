import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyChangeApproval } from "./approval.js";
import {
  applyChangeCard,
  prepareChangeCard,
  rereadMatches,
  STALE_CARD,
  type ChatChange,
} from "./change-confirm.js";
import { confirmGate, connectorRefusal, lookupLiveBin, redactSensitive, SETUP_ERROR, takeProposed, UNCLEAR_APPLY, WRITE_KIND, writeSetup } from "./stock-confirm.js";
import { findTestClientId, TEST_CLIENT_ERROR } from "./test-client.js";
import type { WarehanceClient } from "./warehance-client.js";

const SECRET = "9f3e-APPROVAL-SECRET-VALUE-32!!X";
const thread = { warehanceClientId: 7, warehanceClientName: "AI Testing Client" };
const other = { warehanceClientId: 8, warehanceClientName: "Tempostorm" };

const order = {
  id: 44,
  cancelled: false,
  packing_note: "",
  client: { id: 7, name: "AI Testing Client" },
  order_items: [{ id: 90, quantity: 2, quantity_shipped: 0 }],
};

function writeMock(over: Partial<{ call: WarehanceClient["call"] }> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    async listTools() {
      return [
        { name: "search_inventory_locations", inputSchema: { properties: { sku: {}, location_name: {}, warehouse: {}, client_id: {} } } },
        { name: "search_products", inputSchema: { properties: { client_id: {}, limit: {} } } },
        { name: "search_orders", inputSchema: { properties: { client_id: {}, limit: {}, cursor: {} } } },
      ];
    },
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (over.call) return over.call(name, args);
      if (name === "get_order") return { data: { records: [order] }, failed: false };
      if (name === "search_orders") return { data: { records: [order] }, failed: false };
      if (name === "search_products") {
        return { data: { records: [{ id: 3, name: "Widget", client: { id: 7, name: "AI Testing Client" } }] }, failed: false };
      }
      if (name === "search_inventory_locations") {
        return {
          data: {
            records: [
              {
                quantity: 6,
                available: 6,
                product: { sku: "ABC", client: { id: 7, name: "AI Testing Client" } },
                location: { name: String(args.location_name ?? "A-1"), warehouse: { name: "Main" } },
              },
            ],
          },
          failed: false,
        };
      }
      if (name === "cancel_order" || name === "adjust_inventory" || name === "update_order") {
        return { data: { record: { id: 44, ok: true } }, failed: false };
      }
      return { data: { record: {} }, failed: false };
    },
  } as unknown as WarehanceClient;
  return { client, calls };
}

function card(over: Partial<ChatChange> = {}): ChatChange {
  const now = new Date();
  return {
    kind: "cancel_order",
    args: { order_id: 44 },
    summary: "Cancel the test order",
    before: { id: 44, cancelled: false, packing_note: "" },
    status: "proposed",
    proposedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    result: null,
    error: null,
    ...over,
  };
}

describe("prepareChangeCard", () => {
  it("refuses another client and does not keep a card", async () => {
    const { client, calls } = writeMock();
    const result = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 44 }, summary: "no" }, other, client, 7);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /AI Testing Client/);
    assert.equal(calls.length, 0);
  });

  it("refuses an empty update without calling a write tool", async () => {
    const { client, calls } = writeMock();
    const result = await prepareChangeCard({ kind: "update_order", args: { order_id: 44 }, summary: "no" }, thread, client, 7);
    assert.equal(result.ok, false);
    assert.equal(calls.some((item) => item.name === "update_order"), false);
  });

  it("saves a card after a write-key get_order for AI Testing Client", async () => {
    const { client, calls } = writeMock();
    const result = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 44 }, summary: "Cancel it" }, thread, client, 7);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.card.kind, "cancel_order");
      assert.equal(result.card.status, "proposed");
    }
    assert.equal(calls.every((item) => item.name === "get_order"), true);
  });
});

describe("confirm change", () => {
  it("refuses a non-owner, expired, applied, or applying card", () => {
    const base = {
      role: "owner",
      actorId: "o1",
      threadOwnerId: "o1",
      status: "proposed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      now: Date.now(),
    };
    assert.match(confirmGate({ ...base, role: "admin" }) ?? "", /owner/i);
    assert.match(confirmGate({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() }) ?? "", /expired/i);
    assert.match(confirmGate({ ...base, status: "applied" }) ?? "", /waiting/);
    assert.match(confirmGate({ ...base, status: "applying" }) ?? "", /waiting/);
  });

  it("lets only the first of two confirms claim the card", async () => {
    const store = { status: "proposed", writes: 0 };
    async function confirm() {
      if (!takeProposed(store)) return "refused";
      store.writes += 1;
      return "wrote";
    }
    const results = await Promise.all([confirm(), confirm()]);
    assert.equal(results.filter((item) => item === "wrote").length, 1);
  });

  it("does not write when the target changed since the card was made", async () => {
    const { client, calls } = writeMock({
      call: async (name) => {
        if (name === "get_order") return { data: { records: [{ ...order, cancelled: true }] }, failed: false };
        throw new Error("write should not run");
      },
    });
    const result = await rereadMatches(card(), thread, client, 7);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, STALE_CARD);
    assert.equal(calls.some((item) => item.name === "cancel_order"), false);
  });

  it("calls only the write key with { ...args, approval } that verifies for that tool", async () => {
    const { client, calls } = writeMock();
    const prepared = card({ before: { id: 44, cancelled: false, packing_note: "" } });
    const { card: out } = await applyChangeCard(prepared, { approvedBy: "owner-1", secret: SECRET }, client, () => 1_700_000_000, () => "11111111-1111-4111-8111-111111111111");
    assert.equal(out.status, "applied");
    const write = calls.find((item) => item.name === "cancel_order");
    assert.ok(write);
    const { approval, ...rest } = write!.args;
    assert.deepEqual(rest, { order_id: 44 });
    const payload = verifyChangeApproval(String(approval), SECRET);
    assert.equal(payload.tool, "cancel_order");
    assert.equal(payload.change.order_id, 44);
    assert.equal(typeof payload.change.order_id, "number");
  });

  it("shows Not changed for a clear refusal and unclear when the connector says it may have applied", () => {
    assert.match(connectorRefusal({ error: "Order is already cancelled." }), /^Not changed: Order is already cancelled\.$/);
    assert.match(connectorRefusal({ error: "The change may or may not have been applied: check the bin" }), new RegExp(UNCLEAR_APPLY));
  });

  it("never puts the approval, keys, or secret in errors", async () => {
    const seen: string[] = [];
    const { client } = writeMock({
      call: async (_name, args) => {
        seen.push(String(args.approval));
        return { data: `failed ${args.approval} ${SECRET}`, failed: true };
      },
    });
    const { card: out } = await applyChangeCard(card(), { approvedBy: "owner-1", secret: SECRET }, client);
    const dumped = JSON.stringify(out);
    assert.equal(dumped.includes(SECRET), false);
    assert.equal(dumped.includes(seen[0] ?? "missing-approval"), false);
    assert.equal(redactSensitive(`${SECRET} token`, [SECRET]).includes(SECRET), false);
  });
});

describe("AI Testing Client lock", () => {
  const stock = { sku: "ABC", location_name: "A-1", warehouse: "Main", quantity: -2 };
  const labelled = (clientRow: Record<string, unknown>) => ({
    quantity: 6,
    available: 6,
    product: { sku: "ABC", client: clientRow },
    location: { name: "A-1", warehouse: { name: "Main" } },
  });

  it("refuses an all-clients chat and a chat set to another client ID with the test name", async () => {
    for (const scope of [
      { warehanceClientId: null, warehanceClientName: null },
      { warehanceClientId: 8, warehanceClientName: "AI Testing Client" },
    ]) {
      const { client, calls } = writeMock();
      const result = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 44 }, summary: "x" }, scope, client, 7);
      assert.equal(result.ok, false);
      assert.equal(calls.length, 0);
    }
  });

  it("refuses another client_id and forces the verified one on stock edits", async () => {
    const bad = writeMock();
    const refused = await prepareChangeCard({ kind: "adjust_inventory", args: { ...stock, client_id: 8 }, summary: "x" }, thread, bad.client, 7);
    assert.equal(refused.ok, false);
    assert.equal(bad.calls.length, 0);
    const good = writeMock();
    const kept = await prepareChangeCard({ kind: "adjust_inventory", args: stock, summary: "x" }, thread, good.client, 7);
    assert.equal(kept.ok, true);
    if (kept.ok) assert.equal(kept.card.args.client_id, 7);
  });

  it("refuses a bin whose nested product belongs to another client", async () => {
    const { client } = writeMock({
      call: async () => ({ data: { records: [labelled({ id: 8, name: "Tempostorm" })] }, failed: false }),
    });
    const result = await prepareChangeCard({ kind: "adjust_inventory", args: stock, summary: "x" }, thread, client, 7);
    assert.equal(result.ok, false);
  });

  it("refuses an unlabelled order unless this client's search returns it", async () => {
    const bare = { id: 55, cancelled: false };
    const missing = writeMock({
      call: async (name) => ({ data: { records: name === "get_order" ? [bare] : [] }, failed: false }),
    });
    const refused = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 55 }, summary: "x" }, thread, missing.client, 7);
    assert.equal(refused.ok, false);
    const found = writeMock({ call: async () => ({ data: { records: [bare] }, failed: false }) });
    const allowed = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 55 }, summary: "x" }, thread, found.client, 7);
    assert.equal(allowed.ok, true);
    assert.equal(found.calls.find((item) => item.name === "search_orders")?.args.client_id, 7);
  });

  it("refuses at Confirm when the chat or the card's client no longer matches", async () => {
    const { client, calls } = writeMock();
    const moved = await rereadMatches(card(), { warehanceClientId: 8, warehanceClientName: "AI Testing Client" }, client, 7);
    assert.equal(moved.ok, false);
    const stockCard = card({ kind: "adjust_inventory", args: { ...stock, client_id: 8 } });
    const wrong = await rereadMatches(stockCard, thread, client, 7);
    assert.equal(wrong.ok, false);
    assert.equal(calls.length, 0);
  });

  it("only unlocks when exactly one client has the test name and the list was read", async () => {
    const reply = (records: unknown[], failed = false) => ({ call: async () => ({ data: { records }, failed }) });
    assert.equal(await findTestClientId(reply([{ id: 7, name: "AI Testing Client" }, { id: 8, name: "Tempostorm" }])), 7);
    assert.equal(await findTestClientId(reply([{ id: 8, name: "Tempostorm" }])), null);
    assert.equal(await findTestClientId(reply([{ id: 7, name: "AI Testing Client" }, { id: 9, name: "ai testing client" }])), null);
    assert.equal(await findTestClientId(reply([], true)), null);
  });

  it("refuses a live stock lookup that returns another client's bin", async () => {
    const { client } = writeMock({
      call: async () => ({ data: { records: [labelled({ id: 8, name: "Tempostorm" })] }, failed: false }),
    });
    const row = { sku: "ABC", location: "A-1", warehouse: "Main", qtyBefore: 6, qtyAfter: 4, lotCode: "", ok: null, error: null };
    await assert.rejects(() => lookupLiveBin(client, row, 7), new RegExp(TEST_CLIENT_ERROR));
    await assert.rejects(() => lookupLiveBin(client, row, null), new RegExp(TEST_CLIENT_ERROR));
  });
});

describe("write setup", () => {
  it("needs APPROVAL_SECRET and the write key; the bot key alone is not enough", async () => {
    const previous = process.env.APPROVAL_SECRET;
    process.env.APPROVAL_SECRET = SECRET;
    try {
      const botOnly = {
        select: () => ({
          from: async () => [{ kind: "warehance", secret: "bot", extra: "https://mcp.example/mcp" }],
        }),
      };
      const missing = await writeSetup(botOnly);
      assert.equal(missing.ok, false);

      const ready = await writeSetup({
        select: () => ({
          from: async () => [
            { kind: "warehance", secret: "bot", extra: "https://mcp.example/mcp" },
            { kind: WRITE_KIND, secret: "write-key", extra: null },
          ],
        }),
      });
      assert.equal(ready.ok, true);
    } finally {
      if (previous === undefined) delete process.env.APPROVAL_SECRET;
      else process.env.APPROVAL_SECRET = previous;
    }
    assert.equal(SETUP_ERROR, "Stock changes are not set up.");
  });
});
