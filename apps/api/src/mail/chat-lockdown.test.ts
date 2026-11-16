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

  it("keeps the write key out of Claude's tools and runTurn, and only edit modules may name it", () => {
    const chat = readFileSync(join(here, "chat.service.ts"), "utf8");
    const tools = readFileSync(join(here, "claude-tools.ts"), "utf8");
    const confirm = readFileSync(join(here, "stock-confirm.ts"), "utf8");
    const change = readFileSync(join(here, "change-confirm.ts"), "utf8");
    assert.doesNotMatch(tools, /warehance_write/);
    assert.doesNotMatch(chat, /warehance_write/);
    assert.match(confirm, /warehance_write/);
    assert.doesNotMatch(change, /warehance_write/);
    assert.match(chat, /propose_change/);
    const jobsChat = readFileSync(join(here, "../jobs/jobs-chat.service.ts"), "utf8");
    assert.doesNotMatch(jobsChat, /warehance_write/);
    assert.doesNotMatch(jobsChat, /adjust_inventory/);
  });
});
