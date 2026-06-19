# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Production build (extension + webview + CLI)
npm run build:dev      # Development build (source maps, unminified)
npm run watch          # Concurrent watch mode for extension + webview
node esbuild.mjs --cli-only   # Build just the CLI (cli/dist/gridflow.js)
npm run typecheck      # Type-check all 5 configs: tsconfig.json, .webview, .test, mcp/, cli/
npm test               # Compile tests (tsconfig.test.json → out/) and run them in a VS Code Extension Host
npm run compile-tests  # Just compile the test sources to out/
npm run package        # Bundle as .vsix via vsce
```

Manual smoke-testing: press F5 in VS Code to launch the Extension Development Host (runs `npm run build:dev` automatically via `preLaunchTask`).

### Automated tests

Tests use **Mocha + `@vscode/test-electron`** (driven by `@vscode/test-cli`, configured in `.vscode-test.mjs`). They run inside a real Extension Host, so `vscode`, `workspace.fs`, and a workspace folder (`test-workspace/`, opened by the config) are all live. Test sources live in `src/test/**` and compile via `tsconfig.test.json` to `out/`.

- `src/test/shared/` — pure logic: CSV parse/serialize/round-trip + formula-injection guard, `workflowCore` (cycle detection, `applyRowUpdate` lifecycle, stale rows, markdown report, cost estimation), `sanitize` (hostile sidecar handling, size caps), `provenanceCore` (verification labels with an injected fake `stat`), `makeId`/`emptyRow`/`emptyWorkItem`.
- `src/test/extension/workflowStore.test.ts` — slug generation and sidecar save/load round-trip against the real `.gridflow/` dir.
- `src/test/extension/workflowOrchestrator.test.ts` — the flagship logic: `updateRow` run lifecycle (one run per execution), `durationMs` computation, cost/token aggregation, `dependsOn`/`readyRowIds` DAG, **concurrent updateRow calls** (the per-slug lock), **provenance verification against the real filesystem**, cycle-edge rejection in `addRows`, and pure `workflowToText`. The orchestrator is constructed with no panel/context since `updateRow`/`addRows`/`getWorkflow` don't need them.
- `src/test/webview/store.test.ts` — the `useSyncExternalStore` reducer. The store calls `window.acquireVsCodeApi()` lazily inside `post()`, so a `before()` hook stubs a no-op `window` bridge.
- `src/test/helpers.ts` — `clearWorkflowDir()` (per-test cleanup) and `requireWorkspace()`.

## Architecture

GridFlow ships three separately compiled bundles:

| Bundle | Entry | Target | Runs in |
|--------|-------|--------|---------|
| `dist/extension.js` | `src/extension/extension.ts` | Node16 CJS | VS Code extension host |
| `dist/webview.js` | `src/webview/main.tsx` | ES2022 IIFE | Webview iframe (browser sandbox) |
| `cli/dist/gridflow.js` | `cli/src/index.ts` | Node18 CJS | Standalone terminal (`gridflow` bin) |

`src/shared/` is bundled into **all three** and must not import from `vscode`, the DOM, or Node-only APIs.

### The shared workflow core

`src/shared/workflowCore.ts` holds the **pure** protocol semantics — `applyRowUpdate` (run lifecycle, captures `resolvedInputs`), `readyRowIds`/`readyRowsDetail`, `resolveRowInputs` + `prepareReplay` (single-node replay / edge-state propagation), `budgetStatus`/`dispatchPlan` (spend cap), `buildRows`/`buildFanOut`/`buildColumns`, `fileRiskWarnings`/`riskyRows`, `criticalPath`, `validateWorkflow`/`executionWaves` (CLI lint/plan), cycle detection (`wouldCreateCycle`, `deadlockedRowIds`), `staleRowIds`, `workflowToText`, `workflowToMarkdown`, `workflowStats` (wall-clock vs agent-time), `slugify`. The extension orchestrator and the CLI/MCP servers are thin adapters over it. Sibling shared modules:

- `src/shared/sanitize.ts` — validation + size caps for everything crossing a trust boundary (workspace sidecars, workspace templates, MCP payloads). `loadWorkflow` never blind-casts JSON.
- `src/shared/mutex.ts` — `KeyedMutex`; every sidecar load-modify-write runs under a per-slug lock (`withWorkflowLock`), making parallel `updateRow` calls and the panel's debounced save race-free.
- `src/shared/provenanceCore.ts` — provenance verification with an injected `stat` function (extension wraps `workspace.fs`, CLI wraps `fs.promises`).
- `src/shared/modelPricing.ts` — $/MTok table (prefix-matched, user-overridable via `gridflow.modelPricing`) used to estimate `costUsd` when an agent reports tokens without cost.
- `src/shared/mcpSchemas.ts` / `src/shared/orchestratorPrompt.ts` / `src/shared/dashboardHtml.ts` — MCP tool schemas + prompts, the orchestrator persona, and the self-contained web dashboard, shared by both servers.

### Grid modes

- **workflow** — flagship mode. Opened via `gridflow.openWorkflow`. Rows are first-class work items; the grid shows a status column, an expandable detail drawer, and a summary bar (progress/cost/tokens/duration). Persisted to a `.gridflow/<slug>.json` sidecar (see below).
- **standalone** — opened via command palette; can import/export CSV or send rows to chat
- **csv-editor** — `CustomTextEditorProvider` for `.csv`/`.tsv`; snapshot changes write back via `WorkspaceEdit`
- **lm-tool** — invoked by `vscode.lm.registerTool`; blocks until user clicks "Send to Chat", then resolves with JSON

### Work items (AI workflows)

This is the product's flagship: GridFlow is the **cockpit, not the runner**. A `GridSnapshot` has a `kind` of `'data'` (default) or `'workflow'`. In a workflow grid, each `Row` carries an optional `work?: WorkItem` (see `src/shared/types.ts`): status, assigned agent/model, inputs/outputs, `files` (evidence), `usage` (token/cost), and `history` (`ExecutionRun[]` with `Provenance`). Human-authored fields are edited in the detail drawer (`src/webview/components/RowDetailPanel.tsx` — status and dependencies are editable there too); provenance/usage/logs/history are reported back by the orchestrating agent. Plain `data`/CSV grids leave `work` undefined, so CSV serialization never accounts for it.

Edits flow through the normal `updateState` snapshot round-trip — there are **no** new message types for work-item editing. The store's `updateWork(rowId, patch)` merges into `row.work` and posts the full snapshot; the host persists it. Drawer text fields keep local drafts and commit on blur so keystrokes don't trigger snapshot round-trips.

### Provenance verification ("verify, don't trust")

On every `updateRow` carrying provenance, the orchestrator runs `src/extension/provenanceVerifier.ts` (→ shared `provenanceCore`): paths are normalized (absolute → workspace-relative) and deduped, then each claim is checked — reads against existence, modifications against file mtime inside the run window (±5s slack), deletions against absence. Each `FileRef` gets `verification: 'verified' | 'unverified' | 'missing'`, surfaced as ✓/?/✗ badges in the drawer and in markdown reports; the `updateRow` response includes a `verification` summary so the agent can self-correct.

### Agent orchestration (the cockpit protocol)

`src/extension/workflowOrchestrator.ts` is the extension-host adapter over the shared core, used by both agent surfaces so Copilot and Claude behave identically:

- **Copilot** → `src/extension/lmTool.ts` registers `gridflow_openWorkflow`, `gridflow_addRows`, `gridflow_updateRow`, `gridflow_getWorkflow`, `gridflow_collectStructuredInput` as VS Code language-model tools (also declared in `package.json` `languageModelTools`).
- **Claude / any MCP client** → `src/extension/mcpServer.ts` exposes the same tools over a localhost server with **two transports**: legacy HTTP+SSE (`GET /sse` + `POST /message`, used by the stdio proxy `src/extension/proxyScript.ts` → `~/.gridflow/proxy.js` for Claude desktop) and **Streamable HTTP** (`POST /mcp`, 2025-03-26 spec) for direct connections from Claude Code, Gemini CLI, Codex, Cline, etc. Auth: every request needs the persisted capability token (`~/.gridflow/token`, 0600) via the `x-gridflow-token` header; MCP transports additionally reject any request carrying an `Origin` header (anti-CSRF) and non-loopback `Host` (anti-DNS-rebinding).
- The same server also serves **read-only surfaces** (token via header or `?token=`, same-origin browsers allowed): `GET /api/workflows`, `GET /api/workflows/:slug`, and `GET /dashboard` (self-contained live HTML dashboard, opened via `gridflow.openWebDashboard`).

The workflow is **sub-agent orchestration** — the calling agent *designs the grid*. `openWorkflow` accepts agent-defined `columns` (there is **no** default template) and `rows` where reserved keys (`agent`, `model`, `inputs`, `dependsOn`) configure the sub-agent and all other keys are cell values. `dependsOn` (0-based indices at creation; row ids thereafter) forms a DAG; edges that would close a cycle are **rejected and reported** (`droppedDependencies`). `readyRowIds` (rows whose deps are all `done`; dangling ids count as satisfied) is returned to the agent so it knows what to dispatch in parallel, alongside `staleRowIds` (running >30 min without updates) and `deadlockedRowIds`.

- `openWorkflow(input, { blocking })`: when `blocking` (agent-invoked), opens the panel with `onSendToChat` + `setPendingChatInvocation(true)` and **waits** for "Start Workflow ▸" before resolving with the finalized grid JSON; the panel stays open. Calling again with the same name appends new rows. Palette command uses `{ blocking: false }`.
- `updateRow`: **one `ExecutionRun` per execution** (not per call). It finds the open run (started, no `finishedAt`); `status:'running'` starts/refreshes it, a terminal status finalizes it. **GridFlow computes `durationMs` itself** from the running→done gap. Status is validated against the enum; provenance/log payloads are size-capped; cost is estimated from tokens+model when the agent omits it. Cost/tokens/files aggregate across runs; pushes `setSnapshot` for a live update. When the last row goes terminal, `onWorkflowComplete` fires a notification (with an Export Report action).
- `addRows`: appends sub-agent task rows to a running workflow.

### Sidecar persistence

Workflow documents are stored as human-readable JSON under `.gridflow/<slug>.json` in the first workspace folder (`src/extension/workflowStore.ts`). The whole `GridSnapshot` (with `kind: 'workflow'`) is the file format — diffable and committable, while CSV/TSV files stay plain tabular data. **All load-modify-write cycles run inside `withWorkflowLock(slug, …)`**; the panel's debounced (250ms) save also runs under the lock, and orchestrator writes sync the panel's `latest` (via `pushSnapshot`) so a pending stale save can never clobber an agent write. Loads pass through `sanitizeSnapshot` — a hostile/corrupt sidecar from a cloned repo is clamped or treated as absent, never crashes the panel.

### The CLI (`cli/`)

`gridflow-cli` (bin `gridflow`) is a zero-dependency Node package bundling `cli/src` + `src/shared`:

- `gridflow watch [dir]` — live ANSI dashboard over `.gridflow/*.json` (fs.watch).
- `gridflow report <workflow>` — prints the markdown audit report (`workflowToMarkdown`).
- `gridflow serve [--port N] [--dir path]` — **headless server**: same MCP tools/transports, `/api`, and `/dashboard` without VS Code. `openWorkflow` is non-blocking (no panel to confirm); `collectStructuredInput` is unavailable. Uses the same `~/.gridflow/token`. Exits with a friendly message if the extension already holds the port.

CLI persistence lives in `cli/src/store.ts` (fs-based, same sanitization + lock).

### Extension ↔ Webview boundary

The full message protocol lives in [src/shared/types.ts](src/shared/types.ts). All cross-boundary communication goes through `GridPanel` (`src/extension/gridPanel.ts`) on the host side and `src/webview/vscode.ts` on the webview side. There is no shared runtime object — only serialized messages.

### Webview state

State is managed with a hand-rolled `useSyncExternalStore` store in [src/webview/store.ts](src/webview/store.ts) — no Redux, Zustand, or Context. Cell mutations immediately `post()` a message to the extension. `deleteRows` prunes `dependsOn` references to deleted rows. Grid rows render through a memoized `GridRow` (immutable rows → identity comparison), and `content-visibility: auto` culls offscreen rows, so large grids stay responsive.

### CSS delivery

`styles.css` is read from `dist/webview.css` and inlined as a `<style nonce="...">` tag inside the webview HTML at render time. The CSP uses a crypto-random nonce for `style-src`/`script-src` (plus `style-src-attr 'unsafe-inline'` for React style props). All styling uses VS Code theme CSS variables so the grid inherits light/dark/high-contrast automatically.

### Security model

- Untrusted inputs (workspace sidecars/templates, agent payloads) are sanitized and size-capped (`src/shared/sanitize.ts`).
- CSV exports escape formula triggers (`=`, `+`, `-`, `@`) on string cells by default (`gridflow.csvSafeExport`).
- The local server: capability token (0600 file, timing-safe compare), Origin/Host checks per surface (strict for MCP, same-origin for read-only GETs), no CORS headers ever, 16-client SSE cap, 4MB body cap.
- Writing the Claude Code agent definition to `~/.claude/agents/` requires one-time user consent (stored in `globalState`).

### Advanced feature modules (compliance / verify / advisor / governance)

Four advanced capabilities live in self-contained folders under `src/extension/`, each with a pure `evaluate.ts` (or `aat.ts`) that's unit-tested without `vscode` plus an `index.ts` that does the vscode/MCP wiring. They are **always on** — fully open source, no entitlement or gate. The three MCP tools are aggregated in `src/extension/featureTools.ts` (`FEATURE_MCP_TOOLS`) and merged into the local server's `tools/list` + dispatched in `tools/call`; the compliance audit chain hooks in directly through the orchestrator's `updateRow` (`recordRowUpdate`) and the verifier's stop signal through `evaluateStop`. `McpTool` (schema + handler) is defined in `src/extension/mcpTool.ts`.

- `src/extension/compliance/` — IETF AAT hash-chained `.aat.jsonl`, `verifyChain`, attestation export. `recordRowUpdate` is called on every persisted `updateRow`; `registerComplianceCommands` (wired in `extension.ts`) contributes `gridflow.verifyChain` / `gridflow.exportAttestation`. The 🔒 audit indicator reaches the webview via an `auditChain` flag on the `init` message (always true for workflow panels).
- `src/extension/verify/` — `gridflow_verifyWorkflow` (completeness scoring + VMAO stop conditions + gap-filling replan); also exports `evaluateStop`, called by the orchestrator on every `updateRow`.
- `src/extension/advisor/` — `gridflow_suggestModel` (per-row model recommendation from run history).
- `src/extension/governance/` — `gridflow_projectMemory` (cross-workflow file-failure memory).

### TypeScript configs

- `tsconfig.json` — extension host (Node16 module resolution, no DOM libs)
- `tsconfig.webview.json` — webview (Bundler resolution, React JSX, DOM libs)
- `tsconfig.test.json` — tests; `rootDir` is the **repo root**, output is `out/src/test/**` and the runner glob is `out/**/*.test.js`
- `cli/tsconfig.json` — CLI (Node16, includes `src/shared`)
- `mcp/tsconfig.json` — headless server

All five must pass `npm run typecheck` before a build is considered clean.

### IDs

Every row and column gets a stable string ID via `makeId(prefix)` (e.g., `makeId('col')` → `col_abc123`). These IDs are used for React reconciliation and all grid mutation operations — never use array indices as stable keys. Security-sensitive identifiers (CSP nonces, SSE session ids, the capability token) use `crypto.randomBytes`, never `makeId`/`Math.random`.

### Templates

Templates have three scopes resolved in order: built-in (shipped in `src/shared/builtinTemplates.ts`, immutable) → workspace (`.vscode/gridflow.templates.json`, shape-validated on read) → global (`vscode.ExtensionContext.globalState`). `TemplateService` in `src/extension/templates.ts` owns all persistence.

### Hash references

Typing `#` in a cell opens the native VS Code quick pick (wired in `gridPanel.ts`; file results cached 2s, excludes `node_modules`/`dist`/`out`/`.git`). Built-in items are `#codebase`, `#errors`, `#selection`. The `#token` strings are preserved verbatim in JSON output for downstream agents to resolve; `src/extension/hashCompletions.ts` only extracts them (`extractHashTokens`).
