# GridFlow

**A structured workspace for deterministic AI workflows inside VS Code.**

GridFlow turns a grid into a control surface for AI agents: each row is a first-class unit of work with a status, an assigned agent, inputs/outputs, attached files, logs, token/cost accounting, and full execution history. It's the tool that lets you *see and control what your AI agents are actually doing* — instead of scrolling a giant chat transcript.

CSV / TSV viewing and editing come along for free as a clean secondary feature.

## See it in action

**An agent orchestrating sub-agents through GridFlow.** Claude calls `gridflow_openWorkflow`, you confirm the plan with **Start Workflow ▸**, and the grid becomes a live dashboard as each `gridflow_updateRow` lands — rows go `running → done` and unblock their dependents.

**Open a workflow from the Command Palette.** Everything runs inside VS Code, themed to match your editor.

![Opening a GridFlow workflow from the VS Code Command Palette and expanding a work item](media/ide-hero.gif)

**A work item's full execution trail.** Open any row's detail drawer for status, agent/model, inputs/outputs, dependencies, files touched, tokens, cost, duration, and per-run history.

![Work-item detail drawer with execution history and evidence](media/detail-drawer.gif)

**Edit the grid like a spreadsheet.** Type into cells, add rows, Tab/Enter to move.

![Editing cells and adding a row in a workflow grid](media/editing.gif)

**Reference files and context with `#`.** Type `#` in any cell for `#codebase`, `#errors`, `#selection`, or a file — the token is preserved for the agent to resolve.

![Typing # in a cell to pick a file or context reference](media/ide-hash.gif)

> These GIFs are generated reproducibly — the close-ups drive the real webview bundle, the full-IDE clips drive a real VS Code instance. The agent-orchestration clip pairs the real GridFlow panel with a reconstructed Claude chat (a faithful dramatization of the tool-call loop). See [scripts/demo/](scripts/demo/).

## What it does

1. **AI workflows (flagship).** Run `GridFlow: Open AI Workflow…` to create a workflow grid where every row is a work item. Click a row to open a detail drawer showing status, assigned agent, inputs/outputs, attached evidence files, and an at-a-glance summary — *files read, files modified, tool calls, sub-agents spawned, tokens, cost, duration, runs*. Workflows persist to a human-readable `.gridflow/<name>.json` sidecar so the rich metadata is diffable and committable, while your CSV/TSV files stay clean.
2. **Structured input for chat sessions.** Copilot Chat and compatible agents (like Claude Code) can invoke `#gridflow` to pop open a typed grid, wait for you to fill it in, and receive the result as JSON. Best for orchestrating sub-agents, drafting API specs, enumerating test cases — anything faster to type as a table than as prose.
3. **Custom editor for `.csv` / `.tsv` files.** Right-click any CSV in the Explorer and choose **Open in GridFlow**. Full inline editing with sticky headers, saved through VS Code's normal dirty/save flow.
4. **Standalone grid command.** Run `GridFlow: Open New Grid` for a scratch table — pick a template, fill it in, export to CSV, or send to a chat agent.

The UI inherits your active VS Code theme (light, dark, high contrast) automatically via CSS variables.

## AI workflows — sub-agent orchestration

A GridFlow workflow is a **sub-agent orchestration board**, not a to-do list. When you ask an agent to "spawn sub-agents" or run a multi-step task, it designs a grid for the job and dispatches a sub-agent per row — running independent tasks in parallel and chaining dependent ones — while GridFlow tracks every run.

Each row is a **work item**:

| Field | Set by | Notes |
|-------|--------|-------|
| Cells (columns) | the agent designs them | columns represent what *you* asked for — there is no fixed template |
| Status | you / agent | `pending`, `queued`, `running`, `blocked`, `done`, `failed`, `cancelled` |
| Assigned agent / model | you / agent | which sub-agent runs this row (shown as a chip in the grid) |
| Depends on | agent | other rows that must finish first; rows with no pending deps run in parallel (a DAG) |
| Inputs / outputs | you / agent | the prompt handed to the sub-agent, and its result |
| Duration | **measured by GridFlow** | wall-clock time between `running` and a terminal status — populates automatically |
| Tokens & cost | agent (reported) | aggregated across runs |
| Execution history | agent (reported) | per-run provenance: prompt, context, files read/modified, tool calls, sub-agents, logs |

GridFlow is the **cockpit, not the runner** — the agent spawns and runs the sub-agents; GridFlow structures the work and shows you exactly what each one did.

### The orchestration loop

Both **GitHub Copilot** (via VS Code language-model tools) and **Claude Code** (via the bundled MCP server) drive workflows through the same tools:

1. **`gridflow_openWorkflow`** — the agent **designs the grid** (columns + one row per sub-agent task, with `agent` and `dependsOn` set) and opens it. **The call blocks** while a banner prompts you to review and tweak agent assignments. Click **Start Workflow ▸** and the finalized grid — with row ids and a `readyRowIds` list (tasks whose dependencies are satisfied) — is handed back.
2. The agent **dispatches a sub-agent per ready row, in parallel**, reporting `status: "running"` for each as it starts (GridFlow begins timing).
3. **`gridflow_updateRow`** — as each sub-agent returns, the agent reports `status: "done"`/`"failed"`, `outputs`, provenance (files read/modified, tool calls, sub-agents spawned), and tokens/cost. The grid updates **live** and the response returns the new `readyRowIds` so the next wave can start.
4. **`gridflow_addRows`** — if orchestration uncovers new work, the agent adds rows on the fly.
5. **`gridflow_getWorkflow`** — read the whole board back as structured context instead of re-reading the chat.

Example prompt (Copilot agent mode or Claude Code):

```
Spawn sub-agents to modernise our auth. Use gridflow_openWorkflow — design columns
that fit the job, add a row per sub-agent task, and set dependencies so research runs
first and the three implementation tasks run in parallel after it. Wait for me to
confirm agent assignments, then run them and report each one's progress and cost.
```

One-click **replay** / **branching** build on this same execution-history model.

## Connecting an agent

GridFlow works with both **GitHub Copilot** and **Claude Code** inside VS Code. Copilot needs no setup; Claude Code needs a one-time MCP registration. Both are covered below.

### GitHub Copilot — zero setup

GridFlow contributes its tools as VS Code **language-model tools**, so they're available the moment the extension is installed. There are three ways to use them:

1. **Agent mode (recommended).** In Copilot Chat's *Agent* mode, just describe a multi-step task ("research the auth flow, then refactor it in parallel"). Copilot calls `gridflow_openWorkflow`, `gridflow_updateRow`, `gridflow_addRows`, and `gridflow_getWorkflow` on its own.
2. **The `@gridflow` chat participant.** Type `@gridflow` in Copilot Chat to talk to GridFlow directly. Subcommands: `@gridflow /workflow` (open a workflow), `@gridflow /grid` (open a structured-input grid), `@gridflow /status` (read the current workflow state).
3. **`#`-references in any chat.** Drop `#gridflowWorkflow` (open an AI workflow) or `#gridflow` (open a structured-input grid) into a normal Copilot Chat prompt to pull the grid into that turn.

> **Recommended for reliable orchestration:** in plain agent mode the model follows the tool descriptions, but a workspace instruction file makes it consistently update rows and report files read/modified. Copy [`plugin/templates/copilot-instructions.md`](plugin/templates/copilot-instructions.md) to `.github/copilot-instructions.md` in your project. See [plugin/README.md](plugin/README.md) for the full agent-plugin option.

### Claude Code — one-time MCP setup

Claude Code reaches GridFlow through a local MCP server (default port `54321`) and a tiny stdio proxy that the extension writes to `~/.gridflow/proxy.js` automatically on activation.

**The easy way (recommended):**

1. Open the Command Palette (`Cmd/Ctrl+Shift+P`) and run **GridFlow: Configure Claude Desktop App**. This registers GridFlow with Claude for you, using a portable Node runtime that works on macOS, Linux, and Windows (no hardcoded paths).
2. Run **Developer: Reload Window**.
3. Verify in a terminal: `claude mcp list` should show `gridflow: ✓ Connected`.

**The manual way (if you prefer copy-paste):**

Run **GridFlow: Show MCP Configuration** from the Command Palette. It generates the exact `claude mcp add-json gridflow …` command *for your machine* — copy it, run it in a terminal, then reload the window. (Use this command rather than typing the registration by hand; the Node runtime path is machine-specific and the panel fills it in correctly.)

**Notes:**

- Registration writes to `~/.claude.json` under `mcpServers` — the location both the Claude Code CLI and its VS Code extension read from.
- The `/mcp` panel in Claude only lists *cloud* servers; a local stdio server like GridFlow works but won't appear there. Always verify with `claude mcp list`.
- VS Code must be open with GridFlow running for the proxy to connect — the MCP server lives inside the extension.

> **Recommended for reliable orchestration:** copy [`plugin/templates/CLAUDE.md`](plugin/templates/CLAUDE.md) into your project's root `CLAUDE.md` so Claude consistently follows the workflow loop and reports provenance. See [plugin/README.md](plugin/README.md) for the full plugin/skill option.

## Features

- **Rows as work items:** status, assigned agent, inputs/outputs, evidence files, token/cost, and execution history per row, in an expandable detail drawer
- **Sidecar persistence:** workflows live in `.gridflow/<name>.json` — diffable, committable, portable; CSV/TSV stays plain tabular data
- **Column types:** text, select (dropdown), number, boolean
- **Keyboard navigation:** Tab / Enter to move between cells, arrow keys for directional navigation, `ArrowDown` on the last row appends a new row
- **`#` file references in cells:** type `#` in any text cell to pick a workspace file, `#codebase`, `#errors`, or `#selection` — tokens are preserved in JSON output for downstream agents
- **Template management:** built-in templates (read-only, hideable), plus workspace-scoped and global custom templates with rename/delete/edit
- **CSV import / export:** from file or pasted text; delimiter auto-detected from contents
- **Custom CSV editor** registered at `option` priority — VS Code keeps the default text editor as primary

## Keyboard reference

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

## Agent tools reference

GridFlow exposes the same four tools to both Copilot (VS Code language-model tools) and Claude (MCP):

| Tool | Blocks? | Purpose |
|------|---------|---------|
| `gridflow_openWorkflow` | yes — until **Start Workflow** | Agent designs the grid (columns + sub-agent rows + dependencies), opens it, waits for the user, returns the finalized grid with row ids + `readyRowIds` |
| `gridflow_addRows` | no | Add more sub-agent task rows to a running workflow |
| `gridflow_updateRow` | no | Report a row's status, outputs, provenance, tokens, and cost; grid updates live (duration is auto-measured) |
| `gridflow_getWorkflow` | no | Read the current state of all rows as structured context |
| `gridflow_collectStructuredInput` | yes — until **Send to Chat** | One-shot form fill; returns rows as JSON |

### Structured input (one-shot)

Reference `#gridflow` in Copilot Chat or invoke `gridflow_collectStructuredInput` from an agent. The result returned to the chat is a JSON object:

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

**Tool input schema:**

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Panel title |
| `templateId` | string | `subagent-orchestration`, `api-endpoints`, `test-cases`, or a custom template id |
| `columns` | array | Column definitions (id, name, type, options, placeholder) |
| `rows` | array | Pre-populated rows (objects keyed by column id or name) |
| `instructions` | string | Hint shown above the grid |

The tool times out after 30 minutes if no input is submitted.

## Commands

| Command | Description |
|---------|-------------|
| `GridFlow: Open AI Workflow…` | Create or reopen a `.gridflow/` workflow of work items |
| `GridFlow: Open New Grid` | Open a blank grid using the default template |
| `GridFlow: Open From Template…` | Pick a template from a quick-pick list |
| `GridFlow: Manage Templates` | Open the template manager panel |
| `GridFlow: Open Active File in Grid` | Open the active `.csv`/`.tsv` in the grid editor |
| `GridFlow: Show MCP Configuration` | Show copy-paste setup for connecting Claude Code |
| `GridFlow: Configure Claude Desktop App` | One-click register GridFlow with the Claude desktop app |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `gridflow.defaultTemplate` | `subagent-orchestration` | Template used by `Open New Grid` |
| `gridflow.csvDelimiter` | `auto` | Delimiter for CSV parsing/export (`auto`, `,`, `;`, `\t`, `\|`) |
| `gridflow.mcpPort` | `54321` | Port for the local MCP server (Claude Code / desktop). Set to `0` to disable. |

## Building from source

```bash
npm install
npm run watch        # rebuild on save (extension + webview)
npm run typecheck    # type-check both tsconfigs
npm run build        # production build
npm run package      # produce .vsix
```

Press `F5` in VS Code to open an Extension Development Host with GridFlow loaded.

> **Before publishing:** place a `128×128` PNG at `media/icon.png` and set `publisher` in `package.json` to your Marketplace publisher ID.

## License

MIT
