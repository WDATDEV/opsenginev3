import { staffKeyLooksWritable } from "./claude-tools.js";
import type { McpTool } from "./warehance-client.js";

export const BOT_WRITE_ERROR = "The Warehance bot key can change stock. Use the read-only staff key.";
export const KEYS_SAME_ERROR = "The bot key and the write key must be different.";
export const WRITE_MISSING_TOOL = "The write key must offer adjust_inventory.";

export function refuseStaffKey(tools: McpTool[]) {
  return staffKeyLooksWritable(tools) ? BOT_WRITE_ERROR : null;
}

export function refuseWriteKey(tools: McpTool[]) {
  return tools.some((tool) => tool.name === "adjust_inventory") ? null : WRITE_MISSING_TOOL;
}

export function refuseSameKeys(botKey: string, writeKey: string) {
  return botKey && writeKey && botKey === writeKey ? KEYS_SAME_ERROR : null;
}
