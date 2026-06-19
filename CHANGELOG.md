# Changelog

All notable changes to GridFlow are documented here.

## [0.3.0] — 2026-06-16

Implements the DAG-orchestration frontier from a research survey that cites GridFlow as a premier example. Fully open source (MIT) — every feature is built in and always on.

### Added
- **Single-node replay + edge-state propagation.** Each run now captures its `resolvedInputs` (the row's own prompt plus a snapshot of every dependency's outputs). New `gridflow_replayRow` tool resets one finished/failed row to `pending` and returns those exact inputs, so a failed node re-runs **without** re-running upstream. Tool responses now include `readyRows` (each ready row with its dependency outputs) so orchestrators wire parent results deterministically. The drawer shows captured inputs and a dependency-output preview.
- **Workflow budget cap.** Set a `maxCostUsd` / `maxTokens` ceiling; dispatch halts (`budgetExceeded`) when spent. Summary-bar meter + inline editor.
- **Fan-out / map.** `gridflow_fanOut` (and a "Fan out over a list…" row action) expand one template row into N parallel rows with `{{item}}` / `{{field}}` substitution.
- **Pre-action file-risk gate.** Warns (in the drawer and in `riskyRows`) when a row is about to touch a file a prior failed run stumbled on.
- **Critical-path highlight.** Longest weighted dependency chain marked in the grid and surfaced in the summary bar + tool payload (`criticalPath`).
- **CLI `gridflow lint` + `gridflow plan`.** Validate workflows as a CI gate (non-zero exit on dependency cycles) and print the topological parallelism waves.

### Added — advanced modules (built in, always on)
Four advanced capabilities live in self-contained folders under `src/extension/` (`compliance/`, `verify/`, `advisor/`, `governance/`), each a pure `vscode`-free core plus VS Code / MCP wiring. The three MCP tools are aggregated in `src/extension/featureTools.ts`.
- **Compliance pack (audit-grade provenance).** IETF Agent Audit Trail: every update appends a SHA-256 **hash-chained, tamper-evident** record to `.gridflow/<slug>.aat.jsonl`; commands **GridFlow: Verify Audit Chain** and **GridFlow: Export Compliance Attestation** (session_hash); a 🔒 audit-chain indicator in the summary bar. Built for the EU AI Act (effective Aug 2026).
- **Verifier + adaptive replanning.** `verifier` row role; `gridflow_verifyWorkflow` scores completeness against verifier rows, recommends stop/continue (VMAO stop conditions), and can append a gap-filling sub-DAG.
- **Model advisor.** `gridflow_suggestModel` recommends a model per row from the workflow's own run history (success rate, then cost, then duration).
- **Governance.** `gridflow_projectMemory` aggregates file-failure history across **all** workflows in the repo, flagging repo-wide risk before dispatch.

### Internal
- Pure protocol logic extended in `src/shared/workflowCore.ts` (`resolveRowInputs`, `prepareReplay`, `budgetStatus`/`dispatchPlan`, `buildFanOut`, `fileRiskWarnings`/`riskyRows`, `criticalPath`, `validateWorkflow`/`executionWaves`).
- New test suites under `src/test/shared` and `src/test/extension`: replay, budget, fan-out, file-risk, critical-path, validation/waves, plus the AAT hash chain (tamper/reorder/removal detection, session hash), verifier/VMAO, advisor scoring, governance aggregation, and feature-tool integration through real persistence. 143 tests passing.

## [0.2.0] — 2026-06-11

### Added — audit accuracy ("verify, don't trust")
- **Provenance verification.** Every file an agent reports via `updateRow` is now cross-checked against the real filesystem: reads for existence, modifications for an mtime inside the run window (±5s), deletions for absence. Claims are badged **✓ verified / ? unverified / ✗ missing** in the detail drawer and markdown reports; the `updateRow` response returns a `verification` summary so the orchestrator can self-correct. Paths are normalized (absolute → workspace-relative) and deduped.
- **Cost estimation.** When an agent reports tokens without `costUsd`, GridFlow estimates cost from a built-in $/MTok table (prefix-matched per model; override via the new `gridflow.modelPricing` setting). Estimates are always labeled.

### Added — new surfaces
- **`gridflow` CLI** (`cli/`, zero dependencies): `gridflow watch` (live terminal dashboard), `gridflow report <workflow>` (markdown audit report), and `gridflow serve` (**headless GridFlow** — the same MCP tools, HTTP API, and dashboard without VS Code; `openWorkflow` returns immediately since there's no panel to confirm).
- **Web dashboard** at `GET /dashboard` (new command **GridFlow: Open Web Dashboard**) — a self-contained, live, read-only browser view of all workflows; usable by any browser-based platform.
- **HTTP API**: `GET /api/workflows` and `GET /api/workflows/<slug>` (token-gated) expose workflow state as JSON for external integrations.
- **Streamable HTTP MCP transport** (`POST /mcp`, spec 2025-03-26) so modern MCP clients (Claude Code, Gemini CLI, Codex, Cline, Continue, …) connect directly without the stdio proxy. The legacy SSE transport and proxy remain for Claude desktop. **Show MCP Configuration** now includes ready-made snippets, and the capability token persists across window reloads.

### Added — cockpit UX
- **Workflow summary bar**: progress, running/failed counts, and estimated tokens/cost/duration; running rows show **live elapsed time**.
- **Editable status and dependencies** in the detail drawer (dependency picker is cycle-safe), plus a one-click **Re-queue** for finished/failed rows (history preserved — the next orchestration pass picks them up via `readyRowIds`).
- **Markdown audit report** export (toolbar + `GridFlow: Export Workflow Audit Report…` + completion-notification action) — summary table and per-row provenance with verification badges, PR-description-ready.
- **GridFlow Workflows tree view** in the Explorer with live status counts, and a **completion notification** when a workflow's last row reaches a terminal status.

### Fixed — correctness under parallel orchestration
- **Lost-update race eliminated.** All sidecar load-modify-write cycles (parallel `updateRow`/`addRows` calls and the panel's debounced save) are serialized through a per-workflow lock, and orchestrator writes invalidate pending stale panel saves. Previously, concurrent updates could silently drop runs.
- **Dependency cycles are rejected** (with the dropped edges reported to the agent) instead of silently deadlocking `readyRowIds`; hand-edited cycles are reported as `deadlockedRowIds`.
- **Stale running rows** (no update for 30+ minutes) are reported as `staleRowIds` so orchestrators can recover from dead agents.
- Deleting a row now prunes other rows' `dependsOn` references; dangling references no longer block readiness.
- `updateRow` validates `status` against the enum and reports invalid values clearly.

### Security
- Workflow sidecars and workspace template files are **sanitized on load** (type/enum validation, size caps) — a malformed or hostile `.gridflow/*.json` in a cloned repo can no longer crash the panel.
- Agent payloads (provenance, logs, outputs) are size-capped before persisting, preventing unbounded sidecar growth.
- **CSV exports neutralize formula injection** (`=`, `+`, `-`, `@` at the start of string cells; `gridflow.csvSafeExport`, default on).
- Webview CSP hardened: crypto-random nonce (was `Math.random`), nonce'd `style-src` (dropped blanket `unsafe-inline`); SSE session ids are crypto-random; concurrent SSE clients capped; `~/.gridflow` permissions re-tightened on every activation.
- Writing the Claude Code agent definition to `~/.claude/agents/` now requires **one-time user consent**.

### Performance
- Detail-drawer text fields commit on blur instead of posting the full snapshot per keystroke.
- Grid rows are memoized and offscreen rows are culled via `content-visibility`, keeping large grids responsive.
- File-picker searches are cached (2s) and exclude `dist`/`out`/`.git`.
- Removed the dead `HashAutocomplete` component and its unused message path.

### Internal
- Pure workflow logic extracted to `src/shared/workflowCore.ts` (plus `sanitize`, `mutex`, `modelPricing`, `provenanceCore`, `mcpSchemas`, `orchestratorPrompt`, `dashboardHtml`) — shared verbatim by the extension, the webview, and the CLI; the future open-core seam.
- New test suites: cycle detection, concurrent-update locking, sanitization, provenance verification (pure + real-filesystem), CSV-injection guard, markdown reports (80 tests total).

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
