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
});
