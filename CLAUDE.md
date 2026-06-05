# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Production build (minified, no source maps)
npm run build:dev      # Development build (source maps, unminified)
npm run watch          # Concurrent watch mode for extension + webview
npm run typecheck      # Type-check tsconfig.json, tsconfig.webview.json, and tsconfig.test.json
npm test               # Compile tests (tsconfig.test.json → out/) and run them in a VS Code Extension Host
npm run compile-tests  # Just compile the test sources to out/
npm run package        # Bundle as .vsix via vsce
```

Manual smoke-testing: press F5 in VS Code to launch the Extension Development Host (runs `npm run build:dev` automatically via `preLaunchTask`).

### Automated tests

Tests use **Mocha + `@vscode/test-electron`** (driven by `@vscode/test-cli`, configured in `.vscode-test.mjs`). They run inside a real Extension Host, so `vscode`, `workspace.fs`, and a workspace folder (`test-workspace/`, opened by the config) are all live. Test sources live in `src/test/**` and compile via `tsconfig.test.json` to `out/` (a third config that pulls in the extension + shared sources, plus `webview/store.ts` and `webview/vscode.ts`, with DOM libs).

- `src/test/shared/` — pure logic: CSV parse/serialize/round-trip, `makeId`/`emptyRow`/`emptyWorkItem`.
- `src/test/extension/workflowStore.test.ts` — slug generation and sidecar save/load round-trip against the real `.gridflow/` dir.
- `src/test/extension/workflowOrchestrator.test.ts` — the flagship logic: `updateRow` run lifecycle (one run per execution), `durationMs` computation, cost/token aggregation, `dependsOn`/`readyRowIds` DAG, `addRows`, and pure `workflowToText`. The orchestrator is constructed with no panel/context since `updateRow`/`addRows`/`getWorkflow` don't need them.
- `src/test/webview/store.test.ts` — the `useSyncExternalStore` reducer. The store calls `window.acquireVsCodeApi()` lazily inside `post()`, so a `before()` hook stubs a no-op `window` bridge.
- `src/test/helpers.ts` — `clearWorkflowDir()` (per-test cleanup) and `requireWorkspace()`.

## Architecture

GridFlow is a VS Code extension with two separately compiled bundles:

| Bundle | Entry | Target | Runs in |
|--------|-------|--------|---------|
| `dist/extension.js` | `src/extension/extension.ts` | Node16 CJS | VS Code extension host |
| `dist/webview.js` | `src/webview/main.tsx` | ES2022 IIFE | Webview iframe (browser sandbox) |

`src/shared/` is bundled into **both** and must not import from either side.

### Grid modes

- **workflow** — flagship mode. Opened via `gridflow.openWorkflow`. Rows are first-class work items; the grid shows a status column and an expandable detail drawer. Persisted to a `.gridflow/<slug>.json` sidecar (see below).
- **standalone** — opened via command palette; can import/export CSV or send rows to chat
- **csv-editor** — `CustomTextEditorProvider` for `.csv`/`.tsv`; snapshot changes write back via `WorkspaceEdit`
- **lm-tool** — invoked by `vscode.lm.registerTool`; blocks until user clicks "Send to Chat", then resolves with JSON

### Work items (AI workflows)

This is the product's flagship: GridFlow is the **cockpit, not the runner**. A `GridSnapshot` has a `kind` of `'data'` (default) or `'workflow'`. In a workflow grid, each `Row` carries an optional `work?: WorkItem` (see `src/shared/types.ts`): status, assigned agent/model, inputs/outputs, `files` (evidence), `usage` (token/cost), and `history` (`ExecutionRun[]` with `Provenance`). Human-authored fields are edited in the detail drawer (`src/webview/components/RowDetailPanel.tsx`); provenance/usage/logs/history are meant to be reported back by an external agent through a (future) protocol. Plain `data`/CSV grids leave `work` undefined, so CSV serialization never accounts for it.

Edits flow through the normal `updateState` snapshot round-trip — there are **no** new message types for work-item editing. The store's `updateWork(rowId, patch)` merges into `row.work` and posts the full snapshot; the host persists it.

### Agent orchestration (the cockpit protocol)

`src/extension/workflowOrchestrator.ts` is the **single source of truth** for workflow logic, shared by two agent surfaces so Copilot and Claude behave identically:

- **Copilot** → `src/extension/lmTool.ts` registers `gridflow_openWorkflow`, `gridflow_addRows`, `gridflow_updateRow`, `gridflow_getWorkflow`, `gridflow_collectStructuredInput` as VS Code language-model tools (also declared in `package.json` `languageModelTools`).
- **Claude** → `src/extension/mcpServer.ts` exposes the same tools over a localhost HTTP+SSE MCP server. A generated stdio proxy (`src/extension/proxyScript.ts` → `~/.gridflow/proxy.js`) bridges stdio-only clients (Claude desktop) to the SSE server. Register via `claude mcp add-json gridflow … -s user` (writes `~/.claude.json` `mcpServers`).

The workflow is **sub-agent orchestration** — the calling agent *designs the grid*. `openWorkflow` accepts agent-defined `columns` (there is **no** default template) and `rows` where reserved keys (`agent`, `model`, `inputs`, `dependsOn`) configure the sub-agent and all other keys are cell values. `dependsOn` (0-based indices at creation; row ids thereafter) forms a DAG — `WorkItem.dependsOn`; `readyRowIds` (rows whose deps are all `done`) is returned to the agent so it knows what to dispatch in parallel.

- `openWorkflow(input, { blocking })`: when `blocking` (agent-invoked), opens the panel with `onSendToChat` + `setPendingChatInvocation(true)` and **waits** for "Start Workflow ▸" before resolving with the finalized grid JSON; the panel stays open. Calling again with the same name appends new rows. Palette command uses `{ blocking: false }`.
- `updateRow`: **one `ExecutionRun` per execution** (not per call). It finds the open run (started, no `finishedAt`); `status:'running'` starts/refreshes it, a terminal status finalizes it. **GridFlow computes `durationMs` itself** from the running→done gap, so runtimes populate without the agent. Cost/tokens/files aggregate across runs; pushes `setSnapshot` for a live update.
- `addRows`: appends sub-agent task rows to a running workflow.

### Sidecar persistence

Workflow documents are stored as human-readable JSON under `.gridflow/<slug>.json` in the first workspace folder (`src/extension/workflowStore.ts`). The whole `GridSnapshot` (with `kind: 'workflow'`) is the file format — diffable and committable, while CSV/TSV files stay plain tabular data. Writes from `onSnapshotChanged` are debounced (250ms) and flushed on panel dispose in `extension.ts`.

### Extension ↔ Webview boundary

The full message protocol lives in [src/shared/types.ts](src/shared/types.ts). All cross-boundary communication goes through `GridPanel` (`src/extension/gridPanel.ts`) on the host side and `src/webview/vscode.ts` on the webview side. There is no shared runtime object — only serialized messages.

### Webview state

State is managed with a hand-rolled `useSyncExternalStore` store in [src/webview/store.ts](src/webview/store.ts) — no Redux, Zustand, or Context. Cell mutations immediately `post()` a message to the extension.

### CSS delivery

`styles.css` is read from `dist/webview.css` and inlined as a `<style nonce="...">` tag inside the webview HTML at render time (`gridPanel.renderHtml()`). This is intentional — it bypasses CSP restrictions that block external stylesheet `<link>` tags in webviews. All styling uses VS Code theme CSS variables so the grid inherits light/dark/high-contrast automatically.

### Two TypeScript configs

- `tsconfig.json` — extension host (Node16 module resolution, no DOM libs)
- `tsconfig.webview.json` — webview (Bundler resolution, React JSX, DOM libs)

Both must pass `npm run typecheck` before a build is considered clean.

### IDs

Every row and column gets a stable string ID via `makeId(prefix)` (e.g., `makeId('col')` → `col_abc123`). These IDs are used for React reconciliation and all grid mutation operations — never use array indices as stable keys.

### Templates

Templates have three scopes resolved in order: built-in (shipped in `src/shared/builtinTemplates.ts`, immutable) → workspace (`.vscode/gridflow.templates.json`) → global (`vscode.ExtensionContext.globalState`). `TemplateService` in `src/extension/templates.ts` owns all persistence.

### Hash completions

Typing `#` in a cell opens an autocomplete dropdown (`src/webview/components/HashAutocomplete.tsx`). Built-in items (`#codebase`, `#errors`, `#selection`) are static; file completions come from `src/extension/hashCompletions.ts` via `vscode.workspace.findFiles`. The `#token` strings are preserved verbatim in JSON output for downstream agents to resolve.
