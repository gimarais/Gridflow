---
name: gridflow-orchestration
description: Use when the user asks to orchestrate agents, parallelize work, or run a multi-step task in a project that has GridFlow installed. Explains how to open a workflow grid, dispatch one sub-agent per row, and report status, files read/modified, and estimated token usage back to the live panel.
---

# GridFlow orchestration

GridFlow is a structured grid panel inside the editor that acts as a real-time **cockpit** for multi-step AI work. You design a workflow (custom columns + one row per task), open it as a live panel, dispatch a sub-agent per row, and report progress back so the user can watch status, files touched, token usage, and cost update in real time.

**You are the orchestrator. GridFlow is the cockpit, not the runner** — you spawn and run the sub-agents; GridFlow structures the work and shows the user exactly what each one did.

This skill is tool-agnostic. The same `gridflow_*` tools are exposed to every assistant: GitHub Copilot (VS Code language-model tools), Claude Code / Claude desktop (MCP), and any other MCP or LM-tool client. The behavior below is identical on all of them.

## When to use

Open a workflow immediately — **do not ask "should I use a workflow?"** — when the user says anything like:

- "Create a workflow / pipeline / plan for…"
- "Orchestrate / coordinate agents to…"
- "Break this into tasks / subtasks…"
- "Research X, then implement Y, then test Z"
- "Run these in parallel…"

## The workflow loop — follow this exactly

1. **Open.** Call `gridflow_openWorkflow`. You design the grid: choose columns that match what the user asked for (e.g. Task, Objective, Target file, Acceptance criteria — there is no fixed template) and add one row per sub-agent task. Set `agent` per row. Set `dependsOn` (0-based row indices) for sequential work; omit it for tasks that run in parallel — this forms a dependency DAG.
2. **Wait.** The grid opens and **blocks** until the user reviews agent assignments and clicks **"Start Workflow ▸"**. The tool then returns the grid JSON with `readyRowIds` (rows whose dependencies are all satisfied). Do **not** stop here — this is the signal to start dispatching.
3. **Dispatch each ready row, in parallel:**
   1. Call `gridflow_updateRow(workflowId, rowId, status:"running")` the moment work begins. GridFlow timestamps this and measures wall-clock duration for you — you never compute `durationMs` yourself.
   2. Run the sub-agent with the row's `inputs` prompt (see **Provenance** below for what to append to it).
   3. Call `gridflow_updateRow(workflowId, rowId, status:"done"` or `"failed", outputs, provenance, usage)` when it returns.
4. **Continue.** Every `updateRow` response returns a fresh `readyRowIds` list. Dispatch any newly unblocked rows. Repeat until every row reaches a terminal status (`done` / `failed` / `cancelled`).
5. **Add work as it appears.** If orchestration uncovers new tasks, call `gridflow_addRows` to append them to the running workflow.

There is **one `ExecutionRun` per execution**, not per call: the `running` update opens the run, the terminal update finalizes it. Cost, tokens, and files aggregate across runs.

## MANDATORY: report files read and modified (provenance)

This is the audit trail the user sees in the panel. **An empty provenance shows "0 files read" and makes the tool look broken** — the accuracy of this metadata is the whole point of GridFlow. Always populate it.

Sub-agents do **not** automatically report which files they touched, so you must instruct them to. Append this exact block to the end of **every** sub-agent prompt you put in the `inputs` field:

```
When you have finished, output ONE line at the very end of your response in this exact
format (no markdown, no code fences):
<gf-prov>{"filesRead":["path/a.ts","path/b.ts"],"filesModified":["path/c.ts"],"toolCalls":["Read","Bash","grep"]}</gf-prov>
Include EVERY file path you accessed with Read, Bash, grep, find, cat, or any file tool. This is required.
```

When the sub-agent returns:

- Search its response for the `<gf-prov>…</gf-prov>` line.
- Parse the JSON inside the tags.
- Map `filesRead → provenance.filesRead`, `filesModified → provenance.filesModified`, `toolCalls → provenance.toolCalls` on the `updateRow` call. For modified files include the change type (`"modified"`, `"created"`, or `"deleted"`).
- **Strip the `<gf-prov>` line out of the `outputs` text** before saving it.

If **you** are doing the work directly instead of delegating, track your own Read / Edit / Write / Bash calls and populate `provenance` yourself.

## Report estimated token usage

Populate `usage` on the completion call whenever you can: `inputTokens`, `outputTokens`, `totalTokens`, `costUsd`.

Treat these as **best-effort estimates**, not billing-grade figures. No assistant surface today exposes exact, authoritative token counts to a tool callee, so estimate from the prompt and response you handled (e.g. a token-length estimate of the `inputs` and `outputs`) rather than omitting the field. The panel labels this usage as estimated — an honest estimate is far more useful to the user than a blank. Never invent precise-looking numbers you cannot derive; round estimates are fine.

## Chat narration discipline

Keep chat text short — **one sentence per major step** (e.g. "Dispatching 3 sub-agents now." / "All rows complete."). Do **not** paste findings, file lists, or sub-agent output into the chat. Those belong in `updateRow`'s `outputs` field, where the user reads them in the panel. This keeps the chat clean and saves tokens — but you must still call every required tool and finish the whole loop.

## Tool reference

| Tool | Blocks? | Purpose |
|------|---------|---------|
| `gridflow_openWorkflow` | yes — until **Start Workflow** | You design the grid (columns + sub-agent rows + dependencies), open it, wait for the user, then receive the finalized grid with row ids + `readyRowIds`. |
| `gridflow_addRows` | no | Append more sub-agent task rows to a running workflow. |
| `gridflow_updateRow` | no | Report a row's status, outputs, provenance (files read/modified, tool calls, sub-agents), and estimated usage. Call once with `running`, once with a terminal status. |
| `gridflow_getWorkflow` | no | Read the full current state of all rows as structured context (e.g. to resume, or check what's done before the next phase). |

## Key rules

- Never ask permission to open the grid — call `gridflow_openWorkflow` when the task fits.
- Always send `status:"running"` before the work and a terminal status after — never skip the `running` update, or duration and live progress break.
- Always report `provenance.filesRead` and `provenance.filesModified`. This is non-negotiable.
- GridFlow computes `durationMs`; you don't.
- The calling assistant is the orchestrator. Sub-agents do the work; you report their results back via `updateRow`.
