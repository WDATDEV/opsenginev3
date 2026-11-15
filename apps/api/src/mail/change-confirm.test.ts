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
import { confirmGate, connectorRefusal, redactSensitive, SETUP_ERROR, takeProposed, UNCLEAR_APPLY, WRITE_KIND, writeSetup } from "./stock-confirm.js";
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
      return [{ name: "search_inventory_locations", inputSchema: { properties: { sku: {}, location_name: {}, warehouse: {}, client_id: {} } } }];
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
  } as WarehanceClient;
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
    const result = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 44 }, summary: "no" }, other, client);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /AI Testing Client/);
    assert.equal(calls.length, 0);
  });

  it("refuses an empty update without calling a write tool", async () => {
    const { client, calls } = writeMock();
    const result = await prepareChangeCard({ kind: "update_order", args: { order_id: 44 }, summary: "no" }, thread, client);
    assert.equal(result.ok, false);
    assert.equal(calls.some((item) => item.name === "update_order"), false);
  });

  it("saves a card after a write-key get_order for AI Testing Client", async () => {
    const { client, calls } = writeMock();
    const result = await prepareChangeCard({ kind: "cancel_order", args: { order_id: 44 }, summary: "Cancel it" }, thread, client);
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
    const result = await rereadMatches(card(), thread, client);
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
