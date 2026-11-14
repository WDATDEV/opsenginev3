import type { McpTool } from "./warehance-client.js";

export const CLAUDE_READ_TOOLS = [
  "search_orders",
  "get_order",
  "search_products",
  "search_inventory_locations",
  "search_shipments",
  "search_returns",
  "search_inbound_shipments",
  "list_clients",
] as const;

export type ClaudeReadTool = (typeof CLAUDE_READ_TOOLS)[number];

export const CHAT_CONNECTOR_KINDS = ["warehance", "anthropic"] as const;

const ALLOWED = new Set<string>(CLAUDE_READ_TOOLS);

export function isClaudeReadTool(name: string): name is ClaudeReadTool {
  return ALLOWED.has(name);
}

export function staffKeyLooksWritable(tools: McpTool[]) {
  return tools.some((tool) => tool.name === "adjust_inventory" || tool.annotations?.readOnlyHint !== true);
}

export function assertStaffToolsReadOnly(tools: McpTool[]) {
  if (staffKeyLooksWritable(tools)) {
    throw new Error("The Warehance bot key can change stock. Use the read-only staff key.");
  }
}

export function filterClaudeTools(tools: McpTool[], hideClients: boolean) {
  return tools.filter((tool) => {
    if (!isClaudeReadTool(tool.name)) return false;
    if (hideClients && tool.name === "list_clients") return false;
    return true;
  });
}

export function refuseToolForClaude(name: string): string | null {
  if (name === "propose_send" || name === "propose_inventory" || name === "export_data") return null;
  if (!isClaudeReadTool(name)) {
    return "That tool is not allowed. Look up stock, then wait for the owner to Confirm.";
  }
  return null;
}
