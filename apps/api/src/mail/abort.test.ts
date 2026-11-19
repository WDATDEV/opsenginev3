import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CancelledError, isCancelled, STOPPED, throwIfAborted } from "./abort.js";

describe("chat cancel", () => {
  it("treats abort and cancel as stopped", () => {
    assert.equal(isCancelled(new CancelledError()), true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(isCancelled(abort), true);
    assert.equal(isCancelled(new Error("tool failed")), false);
    assert.equal(STOPPED.startsWith("Stopped."), true);
  });

  it("throws once the signal is aborted", () => {
    const ctrl = new AbortController();
    throwIfAborted(ctrl.signal);
    ctrl.abort();
    assert.throws(() => throwIfAborted(ctrl.signal), CancelledError);
  });
});
