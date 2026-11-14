import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPROVAL_TTL_SECONDS, readApprovalSecret, signApproval, verifyApproval } from "./approval.js";

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
