import * as vscode from 'vscode';

export { ORCHESTRATOR_SYSTEM_PROMPT } from '../shared/orchestratorPrompt';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../shared/orchestratorPrompt';

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
