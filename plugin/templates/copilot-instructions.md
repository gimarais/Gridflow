<!--
  GridFlow — Copilot custom instructions (ungated fallback)

  HOW TO USE: copy this file into your project at  .github/copilot-instructions.md
  GitHub Copilot auto-loads it in normal agent mode — no plugin feature required.

  Canonical source: plugin/skills/gridflow-orchestration/SKILL.md. Keep them in sync.
-->

# GridFlow orchestration

GridFlow is a structured grid panel inside the editor that acts as a real-time **cockpit** for multi-step AI work. You design a workflow (custom columns + one row per task), open it as a live panel, dispatch a sub-agent per row, and report progress back so the user can watch status, files touched, token usage, and cost update in real time.

**You are the orchestrator. GridFlow is the cockpit, not the runner** — you spawn and run the sub-agents; GridFlow structures the work and shows the user exactly what each one did.

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

## MANDATORY: report files read and modified (provenance)

This is the audit trail the user sees in the panel. **An empty provenance shows "0 files read" and makes the tool look broken** — the accuracy of this metadata is the whole point of GridFlow. Always populate it.

Sub-agents do **not** automatically report which files they touched, so you must instruct them to. Append this exact block to the end of **every** sub-agent prompt you put in the `inputs` field:

```
When you have finished, output ONE line at the very end of your response in this exact
format (no markdown, no code fences):
<gf-prov>{"filesRead":["path/a.ts","path/b.ts"],"filesModified":["path/c.ts"],"toolCalls":["Read","Bash","grep"]}</gf-prov>
Include EVERY file path you accessed with Read, Bash, grep, find, cat, or any file tool. This is required.
```

When the sub-agent returns: find the `<gf-prov>…</gf-prov>` line, parse the JSON, map `filesRead → provenance.filesRead`, `filesModified → provenance.filesModified`, `toolCalls → provenance.toolCalls` on the `updateRow` call, and **strip the `<gf-prov>` line out of `outputs`** before saving. If **you** do the work directly, track your own Read / Edit / Write / Bash calls and populate `provenance` yourself.

## Report estimated token usage

Populate `usage` on the completion call whenever you can: `inputTokens`, `outputTokens`, `totalTokens`, `costUsd`. Treat these as **best-effort estimates**, not billing-grade figures — no assistant surface exposes exact token counts to a tool callee, so estimate from the prompt and response you handled rather than omitting the field. The panel labels this usage as estimated. Never invent precise-looking numbers; round estimates are fine.

## Chat narration discipline

Keep chat text short — **one sentence per major step**. Do **not** paste findings, file lists, or sub-agent output into the chat; those belong in `updateRow`'s `outputs` field, where the user reads them in the panel.

## Key rules

- Never ask permission to open the grid — call `gridflow_openWorkflow` when the task fits.
- Always send `status:"running"` before the work and a terminal status after — never skip the `running` update.
- Always report `provenance.filesRead` and `provenance.filesModified`. Non-negotiable.
- GridFlow computes `durationMs`; you don't.
- The calling assistant is the orchestrator. Sub-agents do the work; you report results back via `updateRow`.
