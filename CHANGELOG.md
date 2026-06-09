# Changelog

All notable changes to GridFlow are documented here.

## [0.1.0] — 2026-06-09

### Changed
- **Workflows are now sub-agent orchestration, not a to-do list.** `gridflow_openWorkflow` lets the agent **design the grid columns** to match the user's request (no fixed template) and add one row per sub-agent task with `agent` and `dependsOn` set. Removed the canned `AI Workflow` built-in template and its default Research/Implement/Test/Review rows.
- **Run durations are measured automatically.** `gridflow_updateRow` now models one execution run per row: call it with `status: "running"` when dispatching a sub-agent and `status: "done"`/`"failed"` when it returns — GridFlow computes wall-clock duration itself, so runtimes populate even when the agent can't report them. Tokens/cost/files aggregate across runs.

### Workflow UI refinements
- Removed the manual **Status dropdown** from the row detail drawer — status is driven by agent `updateRow` reports, so the manual control was misleading.
- Removed **Cost** from the summary strip and per-run metrics (it was never populated in practice).
- Fixed **Files read / modified** counting (was gated on a `change` field the agent rarely sets) and added a dedicated **Files touched** section listing the full de-duplicated read/modified paths from run provenance. Manual attachments moved to a separate "Attachments & evidence" section so the two never duplicate.
- `dependsOn` now also accepts existing row-id strings (for `addRows`), and the open/add tool descriptions include a concrete dependency example to make agents actually set it.

### Added (sub-agent orchestration)
- **Dependency DAG** — `WorkItem.dependsOn` lets rows declare prerequisites; independent rows run in parallel. `getWorkflow`/`updateRow` responses include `readyRowIds` (tasks whose dependencies are satisfied) so the agent knows what to dispatch next.
- **`gridflow_addRows`** tool — add sub-agent task rows to a running workflow on the fly (MCP + Copilot LM tool).
- **Agent column** in the workflow grid (assigned-agent chip + a dependency badge), and an always-visible **per-run metrics grid** (status, duration, tokens in→out, cost, sub-agents, tool calls) plus a **Dependencies** section in the row detail drawer.

### Changed
- **Renamed the extension from VSCGrid to GridFlow** — repositioned around deterministic AI workflows, with CSV/TSV editing as a secondary feature. Command ids (`gridflow.*`), settings (`gridflow.*`), the custom-editor view type (`gridflow.csvEditor`), the language-model tool (`gridflow_collectStructuredInput`), and the workspace templates path (`.vscode/gridflow.templates.json`) all moved to the new namespace.

### Added
- **AI workflow grids** — `GridFlow: Open AI Workflow…` creates a grid where each row is a first-class work item with status, assigned agent/model, inputs/outputs, attached evidence files, token/cost usage, and execution history.
- **Work-item detail drawer** — click a row's status badge to open a side panel with an at-a-glance summary (files read/modified, tool calls, sub-agents, tokens, cost, duration, runs), editable core fields, a files & evidence list, and per-run provenance (prompt, context, files, tool calls, logs).
- **Sidecar persistence** — workflows are stored as human-readable `.gridflow/<name>.json` in the workspace; writes are debounced and flushed on panel close.
- Built-in `AI Workflow` template; `kind: 'workflow'` discriminator on grids and templates.
- Work-item data model in `src/shared/types.ts`: `WorkItem`, `ExecutionRun`, `Provenance`, `FileRef`, `ToolCallRecord`, `LogEntry`, `TokenUsage`, `WorkItemStatus`.
- **Agent orchestration tools**, exposed identically to GitHub Copilot (VS Code language-model tools) and Claude Code (MCP), backed by a shared `WorkflowOrchestrator`:
  - `gridflow_openWorkflow` — opens a workflow grid and **blocks until the user assigns agents and clicks "Start Workflow"**, then returns the finalized grid (with row ids). The grid stays open as a live dashboard.
  - `gridflow_updateRow` — agent reports status/outputs/provenance/tokens/cost; the grid updates live.
  - `gridflow_getWorkflow` — read current workflow state as structured context.
- **Local MCP server** (`gridflow.mcpPort`, default 54321) with an SSE endpoint and a generated stdio proxy (`~/.gridflow/proxy.js`) so the Claude desktop app and Claude Code can connect. Commands: `GridFlow: Show MCP Configuration`, `GridFlow: Configure Claude Desktop App`.
- **"Agent is waiting" banner** and a mode-aware **Start Workflow ▸** submit button in workflow grids.
- `gridflow.mcpPort` setting.

## [0.0.1] — 2026-05-21

### Added
- Interactive grid editor with text, select, number, and boolean column types
- Keyboard navigation: Tab/Enter to move between cells, arrow keys, `ArrowDown` on the last row appends a new row
- `#` file reference picker in text cells: `#file:path`, `#codebase`, `#errors`, `#selection`
- Language model tool (`gridflow_collectStructuredInput`) for Copilot Chat and compatible agents — accepts title, template, columns, rows, and instructions; returns structured JSON; times out after 30 minutes
- Custom editor for `.csv` and `.tsv` files with auto-detected delimiter (comma, semicolon, tab, pipe), UTF-8 BOM handling, and round-trip write-back through VS Code's undo/redo stack
- Template system with three scopes: built-in (read-only), workspace (`.vscode/gridflow.templates.json`), and global (VS Code global state)
- Template Manager panel (`GridFlow: Manage Templates` command) — hide/restore built-ins, rename/delete/edit workspace and global templates
- Built-in templates: Sub-agent Orchestration, API Endpoints Spec, Test Cases
- CSV import from file or pasted text; CSV export via save dialog
- `gridflow.defaultTemplate` and `gridflow.csvDelimiter` settings
- Theme-aware styling via VS Code CSS variables (light, dark, high contrast)
