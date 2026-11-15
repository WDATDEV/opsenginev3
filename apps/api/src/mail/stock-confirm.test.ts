import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { verifyApproval } from "./approval.js";
import type { StockRow } from "./stock-change.js";
import {
  applyConfirmedRows,
  confirmGate,
  redactSensitive,
  SETUP_ERROR,
  takeProposed,
  UNCLEAR_APPLY,
  writeKeyIsReady,
} from "./stock-confirm.js";

const SECRET = "b".repeat(32);
const row: StockRow = {
  sku: "UFO-1",
  location: "A-1",
  warehouse: "Ops Engine",
  qtyBefore: 6,
  qtyAfter: 0,
  lotCode: "",
  ok: null,
  error: null,
};

const live = [{ sku: "UFO-1", location_name: "A-1", warehouse: "Ops Engine", available: 6, quantity_on_hand: 6 }];

function deps(over: Partial<Parameters<typeof applyConfirmedRows>[2]> = {}) {
  const writes: { name: string; args: Record<string, unknown> }[] = [];
  const staff: { name: string }[] = [];
  return {
    writes,
    staff,
    deps: {
      secret: SECRET,
      writeReady: true,
      nowSeconds: () => 1_700_000_000,
      uuid: () => "11111111-1111-4111-8111-111111111111",
      lookup: async () => {
        staff.push({ name: "search_inventory_locations" });
        return live;
      },
      adjust: async (args: Record<string, unknown>) => {
        writes.push({ name: "adjust_inventory", args });
        return { data: { applied_quantity: -6, capped: false }, failed: false };
      },
      ...over,
    } satisfies Parameters<typeof applyConfirmedRows>[2],
  };
}

describe("confirm gates", () => {
  it("refuses a non-owner, an expired card, and an already applied or applying card", () => {
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
    assert.equal(confirmGate(base), null);
  });

  it("lets only the first of two parallel confirms claim the card", async () => {
    const store = { status: "proposed", writes: 0 };
    async function confirm() {
      if (!takeProposed(store)) return "refused";
      store.writes += 1;
      return "wrote";
    }
    const results = await Promise.all([confirm(), confirm()]);
    assert.equal(results.filter((item) => item === "wrote").length, 1);
    assert.equal(store.writes, 1);
  });
});

describe("applyConfirmedRows", () => {
  it("sends one adjust_inventory per row with a valid approval on the write key, never on the bot key", async () => {
    const { writes, staff, deps: d } = deps();
    const { rows, calls } = await applyConfirmedRows(
      [row],
      { clientId: 9, approvedBy: "owner-1", reason: "Ops Engine Chat zero", note: "Ops Engine Chat zero" },
      d,
    );
    assert.equal(rows[0]?.ok, true);
    assert.equal(writes.length, 1);
    assert.equal(staff.length, 1);
    assert.equal(
      calls.filter((item) => item.name === "adjust_inventory").every((item) => item.role === "write"),
      true,
    );
    assert.equal(
      calls.some((item) => item.name === "adjust_inventory" && item.role === "staff"),
      false,
    );
    const args = writes[0]!.args;
    assert.equal(args.sku, "UFO-1");
    assert.equal(args.location_name, "A-1");
    assert.equal(args.warehouse, "Ops Engine");
    assert.equal(args.quantity, -6);
    assert.equal(args.client_id, 9);
    const payload = verifyApproval(String(args.approval), SECRET);
    assert.equal(payload.quantity, -6);
    assert.equal(payload.nonce, "11111111-1111-4111-8111-111111111111");
    assert.ok(payload.exp - payload.approved_at <= 120);
  });

  it("refuses when APPROVAL_SECRET or the write key is missing and calls nothing", async () => {
    for (const over of [{ secret: null }, { writeReady: false }]) {
      const { writes, staff, deps: d } = deps(over);
      await assert.rejects(
        applyConfirmedRows([row], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d),
        (err: unknown) => err instanceof Error && err.message === SETUP_ERROR,
      );
      assert.equal(writes.length, 0);
      assert.equal(staff.length, 0);
    }
    assert.equal(writeKeyIsReady([{ kind: "warehance", secret: "bot", extra: "https://x" }]), false);
  });

  it("does not retry a failed write and reports that the bin must be checked", async () => {
    const { writes, deps: d } = deps({
      adjust: async (args) => {
        writes.push({ name: "adjust_inventory", args });
        throw new Error("timeout");
      },
    });
    const { rows } = await applyConfirmedRows([row], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d);
    assert.equal(writes.length, 1);
    assert.ok(rows[0]?.error?.startsWith(UNCLEAR_APPLY));
    assert.ok(rows[0]?.error?.includes("timeout"));
    assert.equal(rows[0]?.ok, false);
  });

  it("shows the connector's reason when it clearly refused (nothing changed)", async () => {
    const cases: [{ data: unknown; failed: boolean } | Error, RegExp][] = [
      [{ data: { error: "Approval is not valid." }, failed: true }, /^Not changed: Approval is not valid\.$/],
      [{ data: { error: "Stock changes are not set up on the connector." }, failed: true }, /^Not changed: Stock changes are not set up/],
      [{ data: { error: "Too many requests: the limit is 10 calls per 5 minutes." }, failed: true }, /^Not changed: Too many requests/],
      [new Error("The Warehance connector rejected the staff key."), /^Not changed: The Warehance connector rejected/],
      [new Error("The Warehance connector answered 503."), new RegExp(`^${UNCLEAR_APPLY}`)],
      [{ data: { error: "Something went wrong talking to Warehance. The change may or may not have been applied: check the bin before retrying." }, failed: true }, new RegExp(`^${UNCLEAR_APPLY}`)],
      [{ data: {}, failed: true }, new RegExp(`^${UNCLEAR_APPLY}$`)],
    ];
    for (const [reply, want] of cases) {
      const { deps: d } = deps({
        adjust: async () => {
          if (reply instanceof Error) throw reply;
          return reply;
        },
      });
      const { rows } = await applyConfirmedRows([row], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d);
      assert.match(rows[0]?.error ?? "", want);
      assert.equal(rows[0]?.ok, false);
    }
  });

  it("never puts the secret, keys, or approval strings in logs or errors", async () => {
    const approvalHolder: string[] = [];
    const { deps: d } = deps({
      adjust: async (args) => {
        approvalHolder.push(String(args.approval));
        return { data: `connector failed ${args.approval} ${SECRET}`, failed: true };
      },
    });
    const { rows, calls } = await applyConfirmedRows([row], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d);
    const dumped = JSON.stringify({ rows, error: rows[0]?.error, nonce: rows[0]?.nonce });
    assert.equal(dumped.includes(SECRET), false);
    assert.equal(dumped.includes("APPROVAL_SECRET"), false);
    assert.equal(dumped.includes(approvalHolder[0] ?? "missing-approval"), false);
    assert.equal(redactSensitive(`${approvalHolder[0]} ${SECRET}`, [SECRET]).includes(SECRET), false);
    assert.equal(JSON.stringify(calls.map((item) => ({ role: item.role, name: item.name }))).includes(SECRET), false);
  });

  it("skips the connector when live quantity already matches the target", async () => {
    const { writes, deps: d } = deps({
      lookup: async () => [{ sku: "UFO-1", location_name: "A-1", warehouse: "Ops Engine", available: 0, quantity_on_hand: 0 }],
    });
    const { rows } = await applyConfirmedRows([row], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d);
    assert.equal(writes.length, 0);
    assert.equal(rows[0]?.ok, true);
    assert.equal(rows[0]?.appliedQuantity, 0);
  });

  it("refuses a row that has on hand but no available quantity", async () => {
    const { writes, deps: d } = deps({
      lookup: async () => [{ sku: "UFO-1", location_name: "A-1", warehouse: "Ops Engine", available: 0, quantity_on_hand: 4 }],
    });
    const { rows } = await applyConfirmedRows([row], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d);
    assert.equal(writes.length, 0);
    assert.equal(rows[0]?.ok, false);
  });
});

describe("nonce", () => {
  it("uses a new nonce per row", async () => {
    const nonces: string[] = [];
    const second: StockRow = { ...row, sku: "UFO-2" };
    const { deps: d } = deps({
      uuid: () => {
        const id = randomUUID();
        nonces.push(id);
        return id;
      },
      lookup: async (item) => [
        { sku: item.sku, location_name: item.location, warehouse: item.warehouse, available: 2, quantity_on_hand: 2 },
      ],
    });
    await applyConfirmedRows([row, second], { clientId: null, approvedBy: "owner-1", reason: "r", note: "n" }, d);
    assert.equal(new Set(nonces).size, 2);
  });
});

describe("set quantity", () => {
  it("sends a positive adjust when the target is above on hand", async () => {
    const target: StockRow = { ...row, qtyAfter: 10 };
    const sent: { quantity?: unknown }[] = [];
    const { deps: d } = deps({
      lookup: async () => [{ sku: "UFO-1", location_name: "A-1", warehouse: "Ops Engine", available: 6, quantity_on_hand: 6 }],
      adjust: async (args) => {
        sent.push(args);
        return { data: { applied_quantity: 4, capped: false }, failed: false };
      },
    });
    const { rows } = await applyConfirmedRows([target], { clientId: 9, approvedBy: "owner-1", reason: "r", note: "n" }, d);
    assert.equal(sent[0]?.quantity, 4);
    assert.equal(rows[0]?.ok, true);
  });
});
