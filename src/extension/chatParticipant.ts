import * as vscode from 'vscode';

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the GridFlow orchestration agent embedded in VS Code.

GridFlow is a structured grid panel that acts as a real-time cockpit for multi-step AI work. It lets you design a workflow (custom columns + rows), open it as a live VS Code panel, dispatch sub-agents per row, and display progress, files read, token usage, and cost in real time.

## Act immediately — don't ask before opening the grid

When the user describes a task that can be broken into steps, immediately call gridflow_openWorkflow. Design the grid to match what they asked for (you choose the columns and rows), then the user reviews and clicks "Start Workflow ▸" before anything runs. You are the orchestrator; the grid is your coordination layer.

Triggers — use gridflow_openWorkflow when the user says anything like:
- "Create a workflow / pipeline / plan for..."
- "Orchestrate / coordinate agents to..."
- "Break this into tasks / subtasks..."
- "Research X, then implement Y, then test Z"
- "Run these in parallel..."

Use gridflow_collectStructuredInput when the user needs to fill in a table, list, or form of structured data before you proceed.

## Workflow loop — follow this exactly

1. Call gridflow_openWorkflow — choose columns and one row per sub-agent task. Set dependsOn for sequential work; omit for parallel tasks.
2. The grid opens and BLOCKS until the user clicks "Start Workflow ▸". The tool then returns the grid JSON with readyRowIds.
3. For each row in readyRowIds (in parallel):
   a. Call gridflow_updateRow(workflowId, rowId, status:"running") immediately.
   b. Run the sub-agent with the row's inputs prompt.
   c. Call gridflow_updateRow(workflowId, rowId, status:"done"/"failed", outputs:"...", provenance:{...}, usage:{...}) when it returns.
4. After every updateRow call, check the returned readyRowIds list for newly unblocked tasks and dispatch those.
5. Continue until all rows reach a terminal status (done/failed/cancelled).

Do NOT stop after receiving the Start Workflow response — that is just the signal to begin dispatching.

## MANDATORY: provenance collection

Sub-agents do NOT automatically report which files they accessed — you must instruct them to. ALWAYS append this exact block to the end of every sub-agent prompt in the "inputs" field:

---
When you have finished, output ONE line at the very end of your response in this exact format (no markdown, no code fences):
<gf-prov>{"filesRead":["path/to/file.ts","path/to/other.ts"],"filesModified":["path/changed.ts"],"toolCalls":["Read","Bash","grep"]}</gf-prov>
Include EVERY file path you accessed with Read, Bash, grep, find, cat, or any file tool. This is required.
---

When the sub-agent returns, search its response for the <gf-prov>...</gf-prov> line. If found:
- Parse the JSON inside the tags
- Pass filesRead → provenance.filesRead, filesModified → provenance.filesModified, toolCalls → provenance.toolCalls in updateRow
- Remove the <gf-prov> line from the outputs text before saving

If YOU are doing the work directly (not delegating), track your own Read/Edit/Write/Bash calls and populate provenance yourself.

## Chat narration style

Keep chat text short — one sentence per major step (e.g. "Dispatching 3 sub-agents now." or "All rows complete."). Do NOT paste findings, file lists, or sub-agent output into the chat; those go in updateRow's outputs field where the user can read them in the panel. This saves tokens and keeps the chat clean, but you must still call all required tools and complete the full workflow loop.

## Key rules

- Never ask "should I use a workflow?" — just call gridflow_openWorkflow when the task fits.
- GridFlow computes durationMs automatically from the running→done gap; you do not need to track it.
- The calling agent is the orchestrator. Sub-agents do the work; you report their results back via updateRow.`;

/**
 * Registers the @gridflow VS Code chat participant. Handles natural-language workflow
 * requests by running an agentic loop with the registered GridFlow LM tools — the user
 * never needs to name a specific tool themselves.
 */
export function registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable | undefined {
  if (typeof vscode.chat?.createChatParticipant !== 'function') return undefined;

  const participant = vscode.chat.createChatParticipant(
    'gridflow',
    async (request, ctx, stream, token) => {
      const tools = vscode.lm.tools.filter((t) => t.tags?.includes('gridflow'));

      // Build message history including prior turns in the same chat thread.
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPromptFor(request.command)),
      ];

      for (const turn of ctx.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
            .map((p) => p.value.value)
            .join('');
          if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }

      if (request.prompt.trim()) {
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
      } else if (!request.command) {
        stream.markdown(HELP_TEXT);
        return;
      }

      // Agentic loop — the model picks tools, we execute them and feed results back.
      for (let round = 0; round < 20; round++) {
        const response = await request.model.sendRequest(messages, { tools }, token);

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        const textParts: string[] = [];

        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            stream.markdown(part.value);
            textParts.push(part.value);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(part);
          }
        }

        if (!toolCalls.length) break;

        // Append the assistant turn (text + tool calls) to the history.
        messages.push(
          vscode.LanguageModelChatMessage.Assistant([
            ...textParts.map((t) => new vscode.LanguageModelTextPart(t)),
            ...toolCalls,
          ]),
        );

        // Execute each tool call and append its result.
        for (const call of toolCalls) {
          stream.progress(`${friendlyName(call.name)}…`);
          try {
            const result = await vscode.lm.invokeTool(
              call.name,
              { input: call.input as Record<string, unknown>, toolInvocationToken: request.toolInvocationToken },
              token,
            );
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(call.callId, result.content),
              ]),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(`Error: ${msg}`)]),
              ]),
            );
          }
        }
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon('list-tree');
  context.subscriptions.push(participant);
  return participant;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function systemPromptFor(command: string | undefined): string {
  if (command === 'workflow') {
    return `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nThe user wants to create a workflow. Immediately call gridflow_openWorkflow — design the columns and rows based on their request.`;
  }
  if (command === 'grid') {
    return `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nThe user wants to fill in structured data. Immediately call gridflow_collectStructuredInput with appropriate columns.`;
  }
  if (command === 'status') {
    return `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nThe user wants to check workflow status. Call gridflow_getWorkflow with the workflow id they mention, or ask them which workflow to inspect.`;
  }
  return ORCHESTRATOR_SYSTEM_PROMPT;
}

function friendlyName(toolName: string): string {
  const map: Record<string, string> = {
    gridflow_openWorkflow: 'Opening workflow',
    gridflow_addRows: 'Adding rows',
    gridflow_updateRow: 'Updating row',
    gridflow_getWorkflow: 'Reading workflow',
    gridflow_collectStructuredInput: 'Opening input grid',
  };
  return map[toolName] ?? toolName;
}

const HELP_TEXT = `**GridFlow** — sub-agent orchestration & structured grids in VS Code.

**Start a workflow**
> @gridflow Create a pipeline to refactor the auth system — research, implement, test, review

**Slash commands**
- \`/workflow\` — immediately open a new AI workflow grid
- \`/grid\` — open a structured input grid for the user to fill in
- \`/status\` — read the current state of a workflow

Just describe your task naturally and GridFlow will design the grid and open it.`;
