import * as vscode from 'vscode';
import { GridPanel } from './gridPanel';
import { TemplateService } from './templates';
import { ColumnDef, GridSnapshot, RowData, makeId } from '../shared/types';
import { extractHashTokens } from './hashCompletions';
import {
  WorkflowOrchestrator,
  OpenWorkflowInput,
  UpdateRowInput,
  GetWorkflowInput,
  AddRowsInput,
  ReplayRowInput,
  FanOutInput,
} from './workflowOrchestrator';

interface ToolInput {
  title?: string;
  templateId?: string;
  columns?: ColumnDef[];
  rows?: RowData[];
  instructions?: string;
}

const TOOL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Registers GridFlow's language-model tools for GitHub Copilot (and any vscode.lm client).
 * These mirror the MCP tools exactly — both delegate to the shared WorkflowOrchestrator,
 * so Copilot and Claude drive workflows identically.
 */
export function registerLanguageModelTool(
  context: vscode.ExtensionContext,
  templates: TemplateService,
  orchestrator: WorkflowOrchestrator,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  // ── Workflow: open (blocks until the user clicks "Start Workflow") ──
  disposables.push(
    vscode.lm.registerTool<OpenWorkflowInput>('gridflow_openWorkflow', {
      async prepareInvocation(options) {
        return {
          invocationMessage: `Opening workflow **${options.input.name}** in GridFlow — waiting for you to assign agents and start…`,
        };
      },
      async invoke(options) {
        try {
          const text = await orchestrator.openWorkflow(options.input, { blocking: true });
          return textResult(text);
        } catch (err) {
          if (err instanceof Error && err.message === 'cancelled') {
            return textResult(JSON.stringify({ cancelled: true, reason: 'User closed the grid without starting.' }));
          }
          throw err;
        }
      },
    }),
  );

  // ── Workflow: add sub-agent task rows dynamically ──
  disposables.push(
    vscode.lm.registerTool<AddRowsInput>('gridflow_addRows', {
      async prepareInvocation(options) {
        return { invocationMessage: `Adding ${options.input.rows?.length ?? 0} task(s) to **${options.input.workflowId}**…` };
      },
      async invoke(options) {
        return textResult(await orchestrator.addRows(options.input));
      },
    }),
  );

  // ── Workflow: fan out a template row over a list (map primitive) ──
  disposables.push(
    vscode.lm.registerTool<FanOutInput>('gridflow_fanOut', {
      async prepareInvocation(options) {
        return { invocationMessage: `Fanning out ${options.input.items?.length ?? 0} task(s) in **${options.input.workflowId}**…` };
      },
      async invoke(options) {
        return textResult(await orchestrator.fanOut(options.input));
      },
    }),
  );

  // ── Workflow: update a row (agent reports progress) ──
  disposables.push(
    vscode.lm.registerTool<UpdateRowInput>('gridflow_updateRow', {
      async prepareInvocation(options) {
        return { invocationMessage: `Updating row in **${options.input.workflowId}**…` };
      },
      async invoke(options) {
        return textResult(await orchestrator.updateRow(options.input));
      },
    }),
  );

  // ── Workflow: read current state ──
  disposables.push(
    vscode.lm.registerTool<GetWorkflowInput>('gridflow_getWorkflow', {
      async invoke(options) {
        return textResult(await orchestrator.getWorkflow(options.input));
      },
    }),
  );

  // ── Workflow: replay a single node (cheap failure recovery) ──
  disposables.push(
    vscode.lm.registerTool<ReplayRowInput>('gridflow_replayRow', {
      async prepareInvocation(options) {
        return { invocationMessage: `Replaying row in **${options.input.workflowId}**…` };
      },
      async invoke(options) {
        return textResult(await orchestrator.replayRow(options.input));
      },
    }),
  );

  // ── Legacy one-shot structured-input form ──
  disposables.push(registerCollectStructuredInput(context, templates));

  return vscode.Disposable.from(...disposables);
}

function registerCollectStructuredInput(
  context: vscode.ExtensionContext,
  templates: TemplateService,
): vscode.Disposable {
  return vscode.lm.registerTool<ToolInput>('gridflow_collectStructuredInput', {
    async prepareInvocation(options) {
      const input = options.input;
      const title = input.title ?? 'Collect Structured Input';
      return {
        invocationMessage: `Opening **${title}** in GridFlow…`,
        confirmationMessages: undefined,
      };
    },

    async invoke(options, token) {
      const input = options.input;

      let initial: GridSnapshot;
      try {
        initial = await buildInitialSnapshot(templates, input);
      } catch (err) {
        throw new Error(
          `GridFlow: failed to build grid from tool input — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return await new Promise<vscode.LanguageModelToolResult>((resolve, reject) => {
        let resolved = false;

        function finish(fn: () => void) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutHandle);
          fn();
        }

        const panel = GridPanel.create(context, templates, {
          mode: 'lm-tool',
          title: input.title ?? 'GridFlow — Structured Input',
          initialSnapshot: initial,
          onSendToChat: (snapshot) => {
            finish(() => {
              panel.setPendingChatInvocation(false);
              resolve(
                new vscode.LanguageModelToolResult([
                  new vscode.LanguageModelTextPart(snapshotToToolResult(snapshot)),
                ]),
              );
              panel.panel.dispose();
            });
          },
        });

        panel.setPendingChatInvocation(true);

        panel.panel.onDidDispose(() => {
          finish(() => reject(new vscode.CancellationError()));
        });

        token.onCancellationRequested(() => {
          finish(() => {
            panel.panel.dispose();
            reject(new vscode.CancellationError());
          });
        });

        const timeoutHandle = setTimeout(() => {
          finish(() => {
            panel.panel.dispose();
            vscode.window.showWarningMessage(
              'GridFlow: the structured input grid timed out after 30 minutes without a response.',
            );
            reject(new vscode.CancellationError());
          });
        }, TOOL_TIMEOUT_MS);
      });
    },
  });
}

async function buildInitialSnapshot(
  templates: TemplateService,
  input: ToolInput,
): Promise<GridSnapshot> {
  if (input.templateId) {
    const tpl = await templates.get(input.templateId);
    if (tpl) {
      const rows = (input.rows ?? tpl.seedRows ?? [{}]).map((cells) => ({
        id: makeId('row'),
        cells: normalize(tpl.columns, cells),
      }));
      return {
        title: input.title,
        instructions: input.instructions,
        columns: tpl.columns,
        rows,
      };
    }
  }
  const columns: ColumnDef[] =
    input.columns?.map((c) => ({ ...c, id: c.id ?? makeId('col') })) ?? [
      { id: makeId('col'), name: 'Value', type: 'text' },
    ];
  const rows = (input.rows ?? [{}]).map((cells) => ({
    id: makeId('row'),
    cells: normalize(columns, cells),
  }));
  return { title: input.title, instructions: input.instructions, columns, rows };
}

function normalize(columns: ColumnDef[], cells: RowData): RowData {
  const out: RowData = {};
  for (const col of columns) {
    const raw = cells[col.id] ?? cells[col.name];
    if (raw === undefined || raw === null) {
      out[col.id] = col.type === 'boolean' ? false : col.type === 'number' ? null : '';
    } else {
      out[col.id] = raw;
    }
  }
  return out;
}

/**
 * Convert the grid snapshot to the JSON payload the chat host receives.
 * We also surface any `#…` reference tokens as a top-level array so chat hosts that
 * post-process tool output (e.g. Copilot) can resolve them.
 */
function snapshotToToolResult(snapshot: GridSnapshot): string {
  const rows = snapshot.rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const col of snapshot.columns) {
      out[col.name] = r.cells[col.id];
    }
    return out;
  });
  const references = new Set<string>();
  for (const r of snapshot.rows) {
    for (const col of snapshot.columns) {
      const v = r.cells[col.id];
      if (typeof v === 'string') {
        for (const tok of extractHashTokens(v)) references.add(tok);
      }
    }
  }
  return JSON.stringify(
    {
      columns: snapshot.columns.map((c) => ({ name: c.name, type: c.type, options: c.options })),
      rows,
      references: Array.from(references),
    },
    null,
    2,
  );
}
