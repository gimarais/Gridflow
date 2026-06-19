/**
 * MCP tools contributed by the feature modules (verifier, advisor, governance),
 * merged into the local server's tool list alongside the built-in orchestration
 * tools. The compliance audit chain wires in via the orchestrator's updateRow
 * hook instead, so it isn't an MCP tool.
 */
import type { McpTool } from './mcpTool';
import { verifyTool } from './verify';
import { suggestModelToolDef } from './advisor';
import { projectMemoryToolDef } from './governance';

export const FEATURE_MCP_TOOLS: McpTool[] = [verifyTool, suggestModelToolDef, projectMemoryToolDef];
