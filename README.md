# GridFlow

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://marketplace.visualstudio.com/items?itemName=OkayExtensions.gridflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code ≥1.95](https://img.shields.io/badge/vscode-%5E1.95.0-blue.svg)](https://code.visualstudio.com)

**See exactly what your AI agents are doing — task by task, inside VS Code.**

GridFlow turns a grid into a live orchestration board: each row is a sub-agent task with status, inputs, outputs, attached evidence, token and cost accounting, and a full per-run history. You review the plan before anything starts, watch rows flip `running → done` in real time, and drill into any row for the complete provenance trail — files read, files written, tool calls, sub-agents spawned, duration.

Works with GitHub Copilot (zero setup) and Claude Code (one MCP registration). CSV and TSV editing is included.

## Features at a glance

- Live orchestration board — rows update as agents report `running`, `done`, or `failed`
- Per-row detail drawer — status, agent, model, inputs, outputs, evidence files, tokens, cost, duration, execution history
- Duration auto-measured — GridFlow times each run from `running` to terminal status; agents don't report it
- Dependency DAG — `dependsOn` chains tasks; rows with no pending deps run in parallel
- `#` file references — type `#` in any cell for `#codebase`, `#errors`, `#selection`, or any workspace file
- Sidecar persistence — workflows saved to `.gridflow/<name>.json`, diffable and committable
- Structured chat input — pop a typed grid into Copilot Chat via `#gridflow`; result returned as JSON
- CSV / TSV custom editor — opens `.csv` and `.tsv` files inline; saves through VS Code's normal dirty/save flow
- Template management — built-in templates plus workspace-scoped and global custom templates
- Theme-aware — inherits light, dark, and high-contrast themes automatically via CSS variables

## Getting started

1. Install **GridFlow** from the VS Code Marketplace.
2. Open the Command Palette (`Cmd/Ctrl+Shift+P`) and run **GridFlow: Open AI Workflow…**.
3. In Copilot Chat's *Agent* mode, describe a multi-step task and ask it to use `gridflow_openWorkflow` to design the grid.
4. Review the rows, adjust agent assignments if needed, and click **Start Workflow ▸**.
5. Watch rows update live as each sub-agent completes.

Claude Code users: run **GridFlow: Configure Claude Desktop App** once, then reload the window. See [Claude Code setup](#claude-code--one-time-mcp-setup) for details.

![Opening a GridFlow workflow from the VS Code Command Palette and expanding a work item](media/ide-hero.gif)
*A workflow opened from the Command Palette. The grid becomes a live dashboard as sub-agents run and rows resolve.*

## AI workflows

When you ask Copilot or Claude Code to run a multi-step task, GridFlow is the board they plan and report to. The agent designs the grid — columns, rows, dependencies — and you confirm it before anything starts.

**Try this prompt in Copilot agent mode or Claude Code:**

```
Spawn sub-agents to modernise our auth. Use gridflow_openWorkflow — design columns
that fit the job, add a row per sub-agent task, and set dependencies so research runs
first and the three implementation tasks run in parallel after it. Wait for me to
confirm agent assignments, then run them and report each one's progress and cost.
```

The orchestration loop:

1. The agent calls `gridflow_openWorkflow` with its proposed columns, rows, and `dependsOn` relationships. The call blocks while you review — adjust agent assignments, add rows, reorder.
2. You click **Start Workflow ▸**. The finalized grid — with row ids and a `readyRowIds` list (tasks whose dependencies are satisfied) — is handed back to the agent.
3. The agent dispatches a sub-agent per ready row in parallel, reporting `status: "running"` as each starts. GridFlow begins timing automatically.
4. As each sub-agent finishes, the agent calls `gridflow_updateRow` with `status: "done"` or `"failed"`, outputs, provenance, and tokens. The grid updates live and the response includes the next `readyRowIds`.
5. If orchestration uncovers new work, the agent calls `gridflow_addRows` and the cycle continues.

GridFlow is the cockpit, not the runner. The agent spawns and drives the sub-agents; GridFlow structures the work and shows you what each one did.

### Work item fields

| Field | Set by | Notes |
|-------|--------|-------|
| Cells (columns) | Agent | Agent designs the columns for the job — no fixed template |
| Status | You / agent | `pending` `queued` `running` `blocked` `done` `failed` `cancelled` |
| Agent / model | You / agent | Shown as a chip in the grid; editable before start |
| Depends on | Agent | Forms a DAG; rows with no pending deps run in parallel |
| Inputs / outputs | You / agent | Prompt handed to the sub-agent and its result |
| Duration | GridFlow | Wall-clock time from `running` to terminal status — auto-populated |
| Tokens & cost | Agent | Aggregated across all runs for this row |
| Execution history | Agent | Per-run: prompt, context, files read/modified, tool calls, sub-agents, logs |

![Work-item detail drawer with execution history and evidence](media/detail-drawer.gif)
*The detail drawer shows the full provenance trail for any row: files touched, tool calls, tokens, cost, duration, and per-run history.*

## Connecting an agent

### GitHub Copilot — no setup required

GridFlow registers its tools as VS Code language-model tools the moment the extension is installed. Three ways to use them:

**Agent mode (recommended).** In Copilot Chat's *Agent* mode, describe a multi-step task. Copilot calls `gridflow_openWorkflow`, `gridflow_updateRow`, `gridflow_addRows`, and `gridflow_getWorkflow` on its own.

**`@gridflow` chat participant.** `@gridflow /workflow` opens a workflow, `@gridflow /grid` opens a structured-input grid, `@gridflow /status` reads the current workflow state.

**`#`-references in any chat.** Drop `#gridflowWorkflow` (open a workflow) or `#gridflow` (open a structured-input grid) into a normal Copilot Chat prompt.

For consistent row updates and provenance reporting, copy [`plugin/templates/copilot-instructions.md`](plugin/templates/copilot-instructions.md) to `.github/copilot-instructions.md` in your project. See [plugin/README.md](plugin/README.md).

### Claude Code — one-time MCP setup

Claude Code connects to GridFlow through a local MCP server on port `54321`. The extension writes a stdio proxy to `~/.gridflow/proxy.js` automatically on activation.

**Recommended:**

1. Open the Command Palette and run **GridFlow: Configure Claude Desktop App**. This registers GridFlow using a portable Node runtime with no hardcoded paths.
2. Run **Developer: Reload Window**.
3. Verify in a terminal: `claude mcp list` should show `gridflow: ✓ Connected`.

**Manual (copy-paste):** Run **GridFlow: Show MCP Configuration** from the Command Palette. It generates the exact `claude mcp add-json gridflow …` command for your machine — the Node runtime path is machine-specific, so let the panel fill it in rather than writing it by hand.

Notes:
- Registration writes to `~/.claude.json` under `mcpServers`.
- The `/mcp` panel in Claude lists cloud servers only; use `claude mcp list` to verify a local server.
- VS Code must be open with GridFlow running for the proxy to connect — the MCP server lives inside the extension.

For consistent orchestration, copy [`plugin/templates/CLAUDE.md`](plugin/templates/CLAUDE.md) into your project root. See [plugin/README.md](plugin/README.md).

## Tools reference

GridFlow exposes the same tools to Copilot (VS Code language-model tools) and Claude Code (MCP):

| Tool | Blocks? | What it does |
|------|---------|--------------|
| `gridflow_openWorkflow` | Yes — until **Start Workflow ▸** | Agent submits columns, rows, and dependencies; opens the grid for review; returns the finalized grid with row ids and `readyRowIds` |
| `gridflow_updateRow` | No | Reports status, outputs, provenance, tokens, and cost; triggers a live grid update; returns new `readyRowIds` |
| `gridflow_addRows` | No | Appends sub-agent task rows to a running workflow |
| `gridflow_getWorkflow` | No | Returns current state of all rows as structured context |
| `gridflow_collectStructuredInput` | Yes — until **Send to Chat** | Opens a typed grid, waits for the user, returns rows as JSON |

### Structured input

`gridflow_collectStructuredInput` (or `#gridflow` in Copilot Chat) opens a grid, waits for the user to fill it in, and returns:

```json
{
  "columns": [
    { "name": "Agent", "type": "select", "options": ["Explore", "Plan", "claude"] },
    { "name": "Task",  "type": "text" }
  ],
  "rows": [
    { "Agent": "Explore", "Task": "Find auth middleware" }
  ],
  "references": ["#file:src/auth.ts", "#codebase"]
}
```

**Input schema:**

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Panel title |
| `templateId` | string | `subagent-orchestration`, `api-endpoints`, `test-cases`, or a custom template id |
| `columns` | array | Column definitions — id, name, type, options, placeholder |
| `rows` | array | Pre-populated rows, keyed by column id or name |
| `instructions` | string | Hint text shown above the grid |

The tool times out after 30 minutes if no input is submitted.

## Editing the grid

![Editing cells and adding a row in a workflow grid](media/editing.gif)
*Tab / Enter to navigate between cells. Arrow-down on the last row appends a new one.*

### Keyboard reference

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Move focus right / left |
| `Enter` | Commit and move down |
| `Shift+Enter` | New line within a cell |
| `Escape` | Cancel edit |
| `F2` | Enter edit mode |
| `ArrowDown` on last row | Commit and append a new row |
| `#` on an empty cell | Open file reference picker |
| `Space` on a boolean cell | Toggle checkbox |

### `#` file references

![Typing # in a cell to pick a file or context reference](media/ide-hash.gif)
*Type `#` in any text cell to pick a workspace file or a built-in context token like `#codebase`.*

Type `#` in any text cell to open the reference picker. Built-in tokens: `#codebase`, `#errors`, `#selection`. File paths resolve to `#file:<path>`. All tokens are preserved verbatim in JSON output for downstream agents to resolve.

## Commands

| Command | Description |
|---------|-------------|
| `GridFlow: Open AI Workflow…` | Create or reopen a `.gridflow/` workflow of work items |
| `GridFlow: Open New Grid` | Open a blank grid with the default template |
| `GridFlow: Open From Template…` | Pick a template from the quick-pick list |
| `GridFlow: Manage Templates` | Open the template manager |
| `GridFlow: Open Active File in Grid` | Open the active `.csv` or `.tsv` in GridFlow |
| `GridFlow: Show MCP Configuration` | Generate the `claude mcp add-json` command for this machine |
| `GridFlow: Configure Claude Desktop App` | One-click register GridFlow with the Claude desktop app |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gridflow.defaultTemplate` | `subagent-orchestration` | Template used by **Open New Grid** |
| `gridflow.csvDelimiter` | `auto` | Delimiter for CSV parsing and export — `auto`, `,`, `;`, `\t`, or `\|` |
| `gridflow.mcpPort` | `54321` | Port for the local MCP server. Set to `0` to disable. |

## Contributing

Issues and pull requests are welcome at [github.com/Cinct00/Gridflow](https://github.com/Cinct00/Gridflow). Open an issue before starting significant work so approach can be discussed first.

## License

MIT
