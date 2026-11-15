import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertStaffToolsReadOnly,
  filterClaudeTools,
  refuseToolForClaude,
  staffKeyLooksWritable,
} from "./claude-tools.js";
import type { McpTool } from "./warehance-client.js";
import { BOT_WRITE_ERROR, refuseStaffKey, refuseWriteKey } from "./settings-keys.js";

const read = (name: string, readOnly = true): McpTool => ({
  name,
  description: "lookup",
  annotations: { readOnlyHint: readOnly },
});

describe("claude tools", () => {
  it("drops adjust_inventory even when the description looks harmless", () => {
    const listed = [
      { name: "adjust_inventory", description: "Read a bin", annotations: { readOnlyHint: true } },
      read("search_orders"),
    ];
    assert.deepEqual(
      filterClaudeTools(listed, false).map((tool) => tool.name),
      ["search_orders"],
    );
    assert.throws(() => assertStaffToolsReadOnly(listed), (err: unknown) => err instanceof Error && err.message === BOT_WRITE_ERROR);
  });

  it("refuses a bot key that offers a write tool", () => {
    const tools = [read("search_orders"), { name: "update_widget", annotations: { readOnlyHint: false } }];
    assert.equal(staffKeyLooksWritable(tools), true);
    assert.equal(refuseStaffKey(tools), BOT_WRITE_ERROR);
    assert.throws(() => assertStaffToolsReadOnly(tools), (err: unknown) => err instanceof Error && err.message === BOT_WRITE_ERROR);
    assert.equal(refuseStaffKey([read("search_orders")]), null);
  });

  it("refuses a bot key whose tools omit readOnlyHint", () => {
    assert.equal(refuseStaffKey([{ name: "search_orders" }]), BOT_WRITE_ERROR);
  });

  it("returns an error for adjust_inventory and other non-allowlisted names without calling the connector", () => {
    const calls: string[] = [];
    const call = (name: string) => {
      calls.push(name);
    };
    for (const name of ["adjust_inventory", "import_inventory_locations", "delete_order"]) {
      const refused = refuseToolForClaude(name);
      assert.ok(refused);
      if (!refused) call(name);
    }
    assert.deepEqual(calls, []);
    assert.equal(refuseToolForClaude("search_inventory_locations"), null);
    assert.ok(refuseWriteKey([{ name: "search_orders" }]));
    assert.equal(refuseWriteKey([{ name: "adjust_inventory" }, { name: "get_order" }]), null);
  });
});
