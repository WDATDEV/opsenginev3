import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAT_CONNECTOR_KINDS } from "./claude-tools.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("chat lockdown", () => {
  it("does not let chat code read the write key, REST key, or APPROVAL_SECRET", () => {
    const src = readFileSync(join(here, "chat.service.ts"), "utf8");
    assert.doesNotMatch(src, /warehance_write/);
    assert.doesNotMatch(src, /warehance_api/);
    assert.doesNotMatch(src, /APPROVAL_SECRET/);
    assert.deepEqual(CHAT_CONNECTOR_KINDS, ["warehance", "anthropic"]);
    assert.match(src, /inArray\(connectors\.kind, \["warehance", "anthropic"\]\)/);
  });
});
