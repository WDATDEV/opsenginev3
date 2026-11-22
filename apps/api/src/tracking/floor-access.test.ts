import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Principal } from "@opsengine/kernel";
import { DEV_JWT_SECRET, jwtSecret } from "../auth/jwt-secret.js";
import { LOGIN_LOCK_MS, LOGIN_MAX_FAILURES, LoginLimiter } from "../auth/login-limit.js";
import { directClockAllowed, floorAllowed, hashDeviceToken, newDeviceToken } from "./floor-access.js";

const person = (role: Principal["role"]): Principal => ({ id: "u", email: "a@example.test", name: "A", role, clientIds: null, sections: [] });

describe("floor access", () => {
  it("allows an approved device or someone who may record floor work", () => {
    assert.equal(floorAllowed({ deviceApproved: true }), true);
    assert.equal(floorAllowed({ deviceApproved: false, principal: person("warehouse_manager") }), true);
  });

  it("refuses nobody-signed-in and signed-in people without floor rights", () => {
    assert.equal(floorAllowed({ deviceApproved: false }), false);
    assert.equal(floorAllowed({ deviceApproved: false, principal: person("external_customer") }), false);
    assert.equal(floorAllowed({ deviceApproved: false, principal: person("client_services") }), false);
  });

  it("sends direct check-in and check-out through the QR gate", () => {
    assert.equal(directClockAllowed("in", "kiosk"), false);
    assert.equal(directClockAllowed("out", "kiosk"), false);
    assert.equal(directClockAllowed("in", "qr"), true);
    assert.equal(directClockAllowed("meal_end", "kiosk"), true);
  });

  it("stores a one-way hash of a long random device token", () => {
    const token = newDeviceToken();
    assert.ok(token.length >= 40);
    assert.notEqual(token, newDeviceToken());
    assert.equal(hashDeviceToken(token).length, 64);
    assert.ok(!hashDeviceToken(token).includes(token));
  });

  it("guards every route that acts on a badge", () => {
    const source = readFileSync(new URL("./tracking.controller.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const routes = [...source.matchAll(/@(Get|Post|Delete)\("([^"]+)"\)\n(\s+@UseGuards\((\w+)\)\n)?/g)];
    const open = routes.filter((route) => !route[4]).map((route) => route[2]);
    assert.deepEqual(open, ["gate"]);
    assert.equal(source.includes("OptionalAuthGuard"), false);
  });
});

describe("sign-in protection", () => {
  it("locks after repeated failures, then opens again", () => {
    const limiter = new LoginLimiter();
    for (let index = 0; index < LOGIN_MAX_FAILURES - 1; index += 1) limiter.fail("a@example.test", 1000);
    assert.equal(limiter.retryAfterMs("a@example.test", 1000), 0);
    limiter.fail("a@example.test", 1000);
    assert.ok(limiter.retryAfterMs("a@example.test", 1000) > 0);
    assert.equal(limiter.retryAfterMs("b@example.test", 1000), 0);
    assert.equal(limiter.retryAfterMs("a@example.test", 1000 + LOGIN_LOCK_MS + 1), 0);
  });

  it("clears failures after a correct password", () => {
    const limiter = new LoginLimiter();
    limiter.fail("a@example.test", 1000);
    limiter.succeed("a@example.test");
    for (let index = 0; index < LOGIN_MAX_FAILURES - 1; index += 1) limiter.fail("a@example.test", 1000);
    assert.equal(limiter.retryAfterMs("a@example.test", 1000), 0);
  });

  it("refuses a missing or default JWT secret only in production", () => {
    assert.throws(() => jwtSecret({ NODE_ENV: "production" }), /JWT_SECRET/);
    assert.throws(() => jwtSecret({ NODE_ENV: "production", JWT_SECRET: DEV_JWT_SECRET }), /JWT_SECRET/);
    assert.equal(jwtSecret({ NODE_ENV: "production", JWT_SECRET: "a-real-secret" }), "a-real-secret");
    assert.equal(jwtSecret({ NODE_ENV: "development" }), DEV_JWT_SECRET);
  });
});
