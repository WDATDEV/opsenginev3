import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertBrowserConfirm } from "./browser-confirm.js";

const origin = "https://app.example";

describe("browser confirm", () => {
  it("rejects job tokens and bearer-only calls", () => {
    assert.throws(() => assertBrowserConfirm({ "x-job-token": "abc" }, "cookie", origin), /browser/);
    assert.throws(() => assertBrowserConfirm({ authorization: "Bearer tok" }, undefined, origin), /browser/);
    assert.throws(() => assertBrowserConfirm({ origin }, undefined, origin), /Sign in/);
    assert.throws(() => assertBrowserConfirm({ origin: "https://evil" }, "cookie", origin), /browser/);
    assert.doesNotThrow(() => assertBrowserConfirm({ origin }, "cookie", origin));
  });

  it("APP_ENV=test skips only the address check", () => {
    const preview = { origin: "https://opsengine-a1b2c3d4e-team.vercel.app" };
    assert.doesNotThrow(() => assertBrowserConfirm(preview, "cookie", origin, "test"));
    assert.doesNotThrow(() => assertBrowserConfirm(preview, "cookie", origin, " TEST "));
    // Still required in test: a session cookie, and no job token / bearer-only call.
    assert.throws(() => assertBrowserConfirm(preview, undefined, origin, "test"), /Sign in/);
    assert.throws(() => assertBrowserConfirm({ ...preview, "x-job-token": "abc" }, "cookie", origin, "test"), /browser/);
    assert.throws(() => assertBrowserConfirm({ authorization: "Bearer tok" }, undefined, origin, "test"), /browser/);
  });

  it("anything other than APP_ENV=test is fully checked", () => {
    const preview = { origin: "https://opsengine-a1b2c3d4e-team.vercel.app" };
    for (const env of [undefined, "", "production", "prod", "staging", "testing", "tes"]) {
      assert.throws(() => assertBrowserConfirm(preview, "cookie", origin, env), /browser/, `APP_ENV=${String(env)}`);
    }
  });
});
