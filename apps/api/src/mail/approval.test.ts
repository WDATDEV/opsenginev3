import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_TTL_SECONDS,
  canonicalChange,
  readApprovalSecret,
  signApproval,
  signChangeApproval,
  verifyApproval,
  verifyChangeApproval,
} from "./approval.js";

const SECRET = "a".repeat(32);

function base(over: Partial<Parameters<typeof signApproval>[0]> = {}) {
  const approved_at = 1_700_000_000;
  return {
    sku: "UFO-1",
    location_name: "A-1",
    warehouse: "Ops Engine",
    quantity: -6,
    client_id: 12,
    approved_by: "owner-1",
    approved_at,
    exp: approved_at + 60,
    nonce: "11111111-1111-4111-8111-111111111111",
    ...over,
  };
}

describe("approval", () => {
  it("signs p.sig with exactly the payload keys and a verifiable HMAC", () => {
    const { approval, payload, p } = signApproval(base(), SECRET);
    assert.equal(approval, `${p}.${approval.split(".")[1]}`);
    assert.equal(approval.includes("="), false);
    assert.deepEqual(Object.keys(payload), [
      "v",
      "sku",
      "location_name",
      "warehouse",
      "quantity",
      "client_id",
      "approved_by",
      "approved_at",
      "exp",
      "nonce",
    ]);
    assert.equal(payload.v, 1);
    assert.equal(payload.quantity, -6);
    assert.deepEqual(verifyApproval(approval, SECRET), payload);
  });

  it("fails verification if any payload field changes", () => {
    const { p, approval } = signApproval(base(), SECRET);
    const sig = approval.slice(p.length + 1);
    const json = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(json)) {
      const next = { ...json, [key]: key === "quantity" ? -7 : key === "v" ? 2 : key === "client_id" ? 99 : `${json[key]}x` };
      const tamperedP = Buffer.from(JSON.stringify(next)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      assert.throws(() => verifyApproval(`${tamperedP}.${sig}`, SECRET), /Approval is not valid/);
    }
    assert.throws(() => verifyApproval(`${p}.${sig.slice(0, -2)}aa`, SECRET), /Approval is not valid/);
  });

  it("rejects expiry more than 120 seconds after approved_at", () => {
    const approved_at = 1_700_000_000;
    assert.throws(
      () => signApproval(base({ approved_at, exp: approved_at + APPROVAL_TTL_SECONDS + 1 }), SECRET),
      /120 seconds/,
    );
    const ok = signApproval(base({ approved_at, exp: approved_at + APPROVAL_TTL_SECONDS }), SECRET);
    assert.equal(ok.payload.exp - ok.payload.approved_at, APPROVAL_TTL_SECONDS);
  });

  it("requires a 32-byte secret from the environment only", () => {
    assert.equal(readApprovalSecret({} as NodeJS.ProcessEnv), null);
    assert.equal(readApprovalSecret({ APPROVAL_SECRET: "short" } as NodeJS.ProcessEnv), null);
    assert.equal(readApprovalSecret({ APPROVAL_SECRET: SECRET } as NodeJS.ProcessEnv), SECRET);
  });
});

describe("approval v2", () => {
  const change = { order_id: 9, packing_note: "leave at dock" };

  function v2(over: Partial<Parameters<typeof signChangeApproval>[0]> = {}) {
    const approved_at = 1_700_000_000;
    return {
      tool: "update_order",
      change,
      approved_by: "owner-1",
      approved_at,
      exp: approved_at + 60,
      nonce: "11111111-1111-4111-8111-111111111111",
      ...over,
    };
  }

  it("signs a v2 payload whose integers stay numbers", () => {
    const { approval, payload } = signChangeApproval(v2(), SECRET);
    assert.equal(approval.includes("="), false);
    assert.equal(payload.v, 2);
    assert.equal(payload.tool, "update_order");
    assert.equal(payload.change.order_id, 9);
    assert.equal(typeof payload.change.order_id, "number");
    assert.deepEqual(verifyChangeApproval(approval, SECRET), payload);
    assert.deepEqual(payload.change, canonicalChange({ packing_note: "leave at dock", order_id: 9 }));
  });

  it("fails verification if the tool or any change value is altered", () => {
    const { p, approval } = signChangeApproval(v2(), SECRET);
    const sig = approval.slice(p.length + 1);
    const json = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    const tamper = (next: Record<string, unknown>) => {
      const tamperedP = Buffer.from(JSON.stringify(next)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      assert.throws(() => verifyChangeApproval(`${tamperedP}.${sig}`, SECRET), /Approval is not valid/);
    };
    tamper({ ...json, tool: "cancel_order" });
    tamper({ ...json, change: { ...(json.change as object), order_id: 10 } });
    tamper({ ...json, approved_by: "other" });
  });

  it("rejects expiry more than 120 seconds after approved_at", () => {
    const approved_at = 1_700_000_000;
    assert.throws(
      () => signChangeApproval(v2({ approved_at, exp: approved_at + APPROVAL_TTL_SECONDS + 1 }), SECRET),
      /120 seconds/,
    );
  });
});
