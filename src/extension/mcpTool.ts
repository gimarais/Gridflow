/**
 * A locally-contributed MCP tool: its JSON schema plus a handler. Feature
 * modules (verify, advisor, governance) export these and the MCP server merges
 * them into the tool list alongside the built-in orchestration tools.
 */
export interface McpTool {
  /** MCP tool schema (name, description, inputSchema) — same shape as MCP_TOOLS entries. */
  schema: unknown;
  /** Execute the tool; returns the text payload sent back to the agent. */
  handler(args: Record<string, unknown>): Promise<string>;
}
