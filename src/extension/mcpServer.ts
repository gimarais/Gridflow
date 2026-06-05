import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './chatParticipant';
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
} from './workflowOrchestrator';

const TOOL_TIMEOUT_MS = 30 * 60 * 1000;

/** Cap on a single MCP request body to avoid unbounded memory growth. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Constant-time string compare that never throws on length mismatch. */
function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

type CollectInput = {
  title?: string;
  templateId?: string;
  columns?: Array<{ name: string; type: string; id?: string; options?: string[]; placeholder?: string }>;
  rows?: RowData[];
  instructions?: string;
};

/**
 * HTTP+SSE MCP server that exposes GridFlow to Claude Code and the Claude desktop app.
 * All workflow logic lives in the shared WorkflowOrchestrator so the MCP surface and
 * the Copilot LM-tool surface behave identically.
 *
 * Tools:
 *   gridflow_openWorkflow   — opens the grid and WAITS for the user to fill in & submit
 *   gridflow_updateRow      — agent reports status/provenance/cost; pushed live
 *   gridflow_getWorkflow    — read current grid state as structured context
 *   gridflow_collectStructuredInput — one-shot form fill (legacy)
 */
export class GridFlowMcpServer {
  private server: http.Server | null = null;
  private sseClients = new Map<string, http.ServerResponse>();

  /**
   * Capability token required on every /sse and /message request. Written to
   * ~/.gridflow/token (mode 0600) at activation; the stdio proxy reads it and sends
   * it as the `x-gridflow-token` header. Browsers cannot read that file or set the
   * header on an EventSource, so a malicious web page cannot drive this server.
   */
  readonly token = crypto.randomBytes(24).toString('hex');

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
    readonly port: number,
    private readonly orchestrator: WorkflowOrchestrator,
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.dispatch(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, '127.0.0.1', resolve);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /* ── HTTP routing ──────────────────────────────────────────────────── */

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    // No CORS headers on purpose: the legitimate client is the local stdio proxy
    // (a Node process), never a browser. Without Access-Control-Allow-Origin a web
    // page cannot read responses, and the checks in authorize() block it outright.
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    // /health stays open (no sensitive data) so connectivity can be probed.
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'gridflow-mcp', version: '0.1.0' }));
      return;
    }

    if (!this.authorize(req)) { res.writeHead(403); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/sse') {
      this.handleSse(req, res);
    } else if (req.method === 'POST' && url.pathname === '/message') {
      this.handlePost(req, res, url.searchParams.get('sessionId') ?? '');
    } else {
      res.writeHead(404); res.end();
    }
  }

  /**
   * Gate /sse and /message against browser-driven (CSRF) and DNS-rebinding attacks.
   * The stdio proxy sends no Origin, connects to loopback, and carries the token.
   */
  private authorize(req: http.IncomingMessage): boolean {
    // Any browser fetch / EventSource attaches an Origin header; reject those.
    if (req.headers.origin !== undefined) return false;
    // Anti-DNS-rebinding: Host must be loopback on our port.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
    // Shared-secret capability token (timing-safe compare).
    const provided = req.headers['x-gridflow-token'];
    return typeof provided === 'string' && timingSafeEq(provided, this.token);
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientId = makeId('sess');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    this.sseClients.set(clientId, res);
    res.write(`event: endpoint\ndata: http://127.0.0.1:${this.port}/message?sessionId=${clientId}\n\n`);
    req.on('close', () => this.sseClients.delete(clientId));
  }

  private sendSse(clientId: string, obj: unknown): void {
    this.sseClients.get(clientId)?.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  private handlePost(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): void {
    let body = '';
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      body += c.toString();
    });
    req.on('end', async () => {
      if (aborted) return;
      res.writeHead(202); res.end();
      let msg: { id?: unknown; method: string; params?: unknown };
      try { msg = JSON.parse(body); } catch { return; }
      const reply = await this.handle(msg);
      if (reply !== null) this.sendSse(clientId, reply);
    });
  }

  /* ── MCP method dispatch ───────────────────────────────────────────── */

  private async handle(msg: { id?: unknown; method: string; params?: unknown }): Promise<unknown> {
    const id = (msg.id !== undefined ? msg.id : null) as string | number | null;

    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: 'gridflow', version: '0.1.0' },
          },
        };

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };

      case 'tools/call': {
        const p = msg.params as { name: string; arguments?: Record<string, unknown> };
        const args = (p?.arguments ?? {}) as Record<string, unknown>;
        try {
          let text: string;
          switch (p?.name) {
            case 'gridflow_openWorkflow':
              text = await this.orchestrator.openWorkflow(args as unknown as OpenWorkflowInput, { blocking: true });
              break;
            case 'gridflow_addRows':
              text = await this.orchestrator.addRows(args as unknown as AddRowsInput);
              break;
            case 'gridflow_updateRow':
              text = await this.orchestrator.updateRow(args as unknown as UpdateRowInput);
              break;
            case 'gridflow_getWorkflow':
              text = await this.orchestrator.getWorkflow(args as unknown as GetWorkflowInput);
              break;
            case 'gridflow_collectStructuredInput':
              text = await this.invokeCollectInput(args as unknown as CollectInput);
              break;
            default:
              return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${p?.name}` } };
          }
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
        } catch (err) {
          const cancelled = err instanceof Error && err.message === 'cancelled';
          return {
            jsonrpc: '2.0', id,
            error: { code: -32000, message: cancelled ? 'User closed the grid without submitting.' : String(err) },
          };
        }
      }

      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } };

      case 'prompts/get': {
        const { name, arguments: args = {} } = (msg.params ?? {}) as { name?: string; arguments?: Record<string, string> };
        const prompt = MCP_PROMPTS.find((p) => p.name === name);
        if (!prompt) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Prompt "${name}" not found.` } };
        }
        const task = args['task'] ? `\n\nThe user's task: ${args['task']}` : '';
        return {
          jsonrpc: '2.0', id,
          result: {
            description: prompt.description,
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `${ORCHESTRATOR_SYSTEM_PROMPT}${task}\n\nYou are now operating as the GridFlow orchestrator. Use the gridflow tools proactively whenever the user describes a task that can be broken into steps or coordinated across agents. Respond to the user's first message.`,
                },
              },
            ],
          },
        };
      }

      default:
        if (id !== null) {
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
        }
        return null;
    }
  }

  /* ── Legacy one-shot form fill ─────────────────────────────────────── */

  private async invokeCollectInput(input: CollectInput): Promise<string> {
    const initial = await buildInitialSnapshot(this.templates, input);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const panel = GridPanel.create(this.context, this.templates, {
        mode: 'lm-tool',
        title: input.title ?? 'GridFlow — Structured Input',
        initialSnapshot: initial,
        onSendToChat: (snapshot) => {
          settle(() => {
            panel.setPendingChatInvocation(false);
            resolve(snapshotToText(snapshot));
            panel.panel.dispose();
          });
        },
      });

      panel.setPendingChatInvocation(true);
      panel.panel.onDidDispose(() => settle(() => reject(new Error('cancelled'))));

      const timer = setTimeout(() => {
        settle(() => {
          panel.panel.dispose();
          vscode.window.showWarningMessage('GridFlow: grid timed out after 30 minutes.');
          reject(new Error('cancelled'));
        });
      }, TOOL_TIMEOUT_MS);
    });
  }
}

/* ── Helpers for collectStructuredInput ──────────────────────────────── */

async function buildInitialSnapshot(templates: TemplateService, input: CollectInput): Promise<GridSnapshot> {
  if (input.templateId) {
    const tpl = await templates.get(input.templateId);
    if (tpl) {
      const rows = (input.rows ?? tpl.seedRows ?? [{}]).map((cells) => ({
        id: makeId('row'),
        cells: normalizeRow(tpl.columns, cells),
      }));
      return { title: input.title, instructions: input.instructions, columns: tpl.columns, rows };
    }
  }
  const columns: ColumnDef[] =
    input.columns?.map((c) => ({
      id: c.id ?? makeId('col'),
      name: c.name,
      type: c.type as ColumnDef['type'],
      options: c.options,
      placeholder: c.placeholder,
    })) ?? [{ id: makeId('col'), name: 'Value', type: 'text' }];
  const rows = (input.rows ?? [{}]).map((cells) => ({ id: makeId('row'), cells: normalizeRow(columns, cells) }));
  return { title: input.title, instructions: input.instructions, columns, rows };
}

function normalizeRow(columns: ColumnDef[], cells: RowData): RowData {
  const out: RowData = {};
  for (const col of columns) {
    const raw = cells[col.id] ?? cells[col.name];
    out[col.id] = raw === undefined || raw === null
      ? col.type === 'boolean' ? false : col.type === 'number' ? null : ''
      : raw;
  }
  return out;
}

function snapshotToText(snapshot: GridSnapshot): string {
  const rows = snapshot.rows.map((r) => {
    const obj: Record<string, unknown> = {};
    for (const col of snapshot.columns) obj[col.name] = r.cells[col.id];
    return obj;
  });
  const refs = new Set<string>();
  for (const r of snapshot.rows)
    for (const col of snapshot.columns) {
      const v = r.cells[col.id];
      if (typeof v === 'string') for (const t of extractHashTokens(v)) refs.add(t);
    }
  return JSON.stringify(
    { columns: snapshot.columns.map((c) => ({ name: c.name, type: c.type })), rows, references: Array.from(refs) },
    null,
    2,
  );
}

/* ── MCP prompt registry ─────────────────────────────────────────────── */

export const MCP_PROMPTS = [
  {
    name: 'gridflow-orchestrate',
    description:
      'Configure Claude as a GridFlow workflow orchestrator. After loading this prompt, Claude will ' +
      'proactively use gridflow_openWorkflow, gridflow_updateRow, and related tools whenever you ' +
      'describe a multi-step task — no need to name specific tools yourself.',
    arguments: [
      {
        name: 'task',
        description: 'Optional: the task or goal you want to orchestrate (e.g. "refactor the auth system").',
        required: false,
      },
    ],
  },
];

/* ── MCP tool schemas ────────────────────────────────────────────────── */

// Shared shape for a sub-agent task row across openWorkflow / addRows.
const ROW_ITEM_SCHEMA = {
  type: 'object',
  description:
    'A sub-agent task. Keys matching your column names become cell values (e.g. {"Task":"…"}). ' +
    'Reserved keys configure the sub-agent: "agent" (which agent/sub-agent runs it), "model", ' +
    '"inputs" (the prompt/context to hand the sub-agent), and "dependsOn" (array of 0-based indices ' +
    'of earlier rows that must finish first — omit for rows that can run in parallel).',
  properties: {
    agent: { type: 'string' },
    model: { type: 'string' },
    inputs: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'number' } },
  },
  additionalProperties: true,
};

const COLUMNS_SCHEMA = {
  type: 'array',
  description:
    'Design the columns to represent exactly what the user asked for (e.g. Task, Objective, Target file, Acceptance criteria). ' +
    'You choose these — there is no fixed template.',
  items: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['text', 'select', 'number', 'boolean'] },
      options: { type: 'array', items: { type: 'string' } },
    },
  },
};

export const MCP_TOOLS = [
  {
    name: 'gridflow_openWorkflow',
    description:
      'Opens a sub-agent orchestration workflow grid. Use whenever the user asks to orchestrate agents, parallelize work, or run a multi-step task. ' +
      'YOU design the grid: choose columns for the work, one row per sub-agent task. ' +
      'Set "dependsOn" for sequential tasks (0-based indices); omit for tasks that run in parallel. Set "agent" per row.\n\n' +
      'CALL SEQUENCE after the user clicks "Start Workflow" (the tool unblocks and returns the grid JSON with readyRowIds):\n' +
      '1. For each row in readyRowIds, dispatch it in parallel:\n' +
      '   a. Call gridflow_updateRow(workflowId, rowId, status:"running") immediately.\n' +
      '   b. Run the sub-agent with the row\'s inputs.\n' +
      '   c. Call gridflow_updateRow(workflowId, rowId, status:"done"/"failed", outputs:"...", provenance:{...}, usage:{...}).\n' +
      '2. After each updateRow response, dispatch any new rowIds in its readyRowIds list.\n' +
      '3. Continue until all rows are terminal.\n\n' +
      'PROVENANCE — sub-agents do NOT auto-report file access. ALWAYS append to the end of every "inputs" prompt:\n' +
      '"After finishing, output exactly this line at the very end of your response:\n' +
      '<gf-prov>{\"filesRead\":[\"path/a.ts\",\"path/b.ts\"],\"filesModified\":[\"path/c.ts\"],\"toolCalls\":[\"Read\",\"Bash\"]}</gf-prov>\n' +
      'Include every file you accessed. Required for the audit trail."\n' +
      'When the sub-agent returns, extract that line, parse the JSON, pass it to updateRow\'s provenance fields, and strip the line from outputs.\n\n' +
      'CHAT OUTPUT: Keep chat narration minimal — one short sentence per major step (e.g. "Dispatching 3 sub-agents."). ' +
      'Put all findings and results in updateRow outputs so the user can read them in the VS Code panel.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Workflow name / slug (e.g. "auth-refactor").' },
        title: { type: 'string', description: 'Human-readable panel title. Defaults to name.' },
        columns: COLUMNS_SCHEMA,
        rows: { type: 'array', description: 'One row per sub-agent task.', items: ROW_ITEM_SCHEMA },
        instructions: { type: 'string', description: 'One-line instruction shown above the grid.' },
      },
    },
  },
  {
    name: 'gridflow_addRows',
    description:
      'Adds more sub-agent task rows to an already-open workflow. Use when orchestration reveals new work to dispatch ' +
      '(e.g. a research row uncovers three follow-up tasks). The grid updates live. dependsOn here uses 0-based indices within the rows you pass.',
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'rows'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
        rows: { type: 'array', items: ROW_ITEM_SCHEMA },
      },
    },
  },
  {
    name: 'gridflow_updateRow',
    description:
      'Reports a sub-agent\'s progress on a workflow row. Call it TWICE per row: ' +
      '(1) status:"running" the moment work begins — GridFlow timestamps this and measures wall-clock duration automatically. ' +
      '(2) status:"done" or "failed" when work is complete.\n\n' +
      'On the COMPLETION call you MUST populate provenance — this is the audit trail the user sees in the panel:\n' +
      '• provenance.filesRead — every file path you READ during this task (every Read tool call, every grep/find/cat via Bash). ' +
        'Leaving this empty shows "0 files read" to the user.\n' +
      '• provenance.filesModified — every file you CREATED, EDITED, or DELETED (Edit, Write, Bash writes). ' +
        'Include the change type ("modified", "created", or "deleted").\n' +
      '• provenance.toolCalls — notable tool invocations (name + short input/output).\n' +
      '• provenance.subAgents — names of any sub-agents you spawned.\n\n' +
      'Also include outputs (what was produced) and estimated usage (inputTokens, outputTokens, totalTokens, costUsd) — best-effort token estimates, since no surface exposes exact counts to a tool; the panel labels them as estimates. ' +
      'The response returns updated readyRowIds so you know which dependent tasks can now be dispatched.',
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'rowId'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
        rowId: { type: 'string', description: 'The row id from the openWorkflow response.' },
        status: { type: 'string', enum: ['pending', 'queued', 'running', 'blocked', 'done', 'failed', 'cancelled'], description: 'Send "running" when dispatching the sub-agent, then "done"/"failed" when it returns.' },
        agent: { type: 'string', description: 'The sub-agent that ran this row (e.g. "Explore", "general-purpose").' },
        model: { type: 'string', description: 'Model used (e.g. "claude-opus-4-8").' },
        inputs: { type: 'string', description: 'The prompt/context handed to the sub-agent.' },
        outputs: { type: 'string', description: 'What the sub-agent produced.' },
        summary: { type: 'string', description: 'One-line outcome. Defaults to first 240 chars of outputs.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Row ids this row depends on (if changing dependencies).' },
        startedAt: { type: 'string', description: 'ISO timestamp when the run started (optional; GridFlow tracks this automatically).' },
        finishedAt: { type: 'string', description: 'ISO timestamp when the run finished. Defaults to now.' },
        durationMs: { type: 'number', description: 'Wall-clock duration in ms (optional; GridFlow computes it from running→done).' },
        provenance: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            context: { type: 'string' },
            filesRead: {
              type: 'array',
              description: 'Every file path read or searched during this task (Read tool calls, grep, find, cat, etc.). Include ALL of them — the user sees this count in the panel.',
              items: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative file path.' }, note: { type: 'string', description: 'Optional short note (e.g. "searched for auth logic").' } }, required: ['path'] },
            },
            filesModified: {
              type: 'array',
              description: 'Every file created, edited, or deleted during this task (Edit, Write, Bash writes/deletions).',
              items: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative file path.' }, change: { type: 'string', enum: ['modified', 'created', 'deleted'], description: 'How the file was changed.' }, note: { type: 'string', description: 'Optional short note (e.g. "added auth middleware").' } }, required: ['path'] },
            },
            toolCalls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' } }, required: ['name'] } },
            subAgents: { type: 'array', items: { type: 'string' } },
          },
        },
        usage: {
          type: 'object',
          description: 'Estimated token usage for this run (best-effort — exact counts are not exposed to tools). The panel labels these as estimates.',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            totalTokens: { type: 'number' },
            costUsd: { type: 'number' },
          },
        },
        logs: {
          type: 'array',
          items: { type: 'object', properties: { message: { type: 'string' }, level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] }, at: { type: 'string' } }, required: ['message'] },
        },
      },
    },
  },
  {
    name: 'gridflow_getWorkflow',
    description:
      'Returns the current state of all rows in a workflow — status, assigned agent, inputs, outputs, cost, run count. ' +
      'Use to read structured context from a running workflow or to resume one.',
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
      },
    },
  },
  {
    name: 'gridflow_collectStructuredInput',
    description:
      'Opens an interactive grid in VS Code and blocks until the user fills it in and clicks "Send to Chat". ' +
      'Returns the rows as JSON. For one-shot form-style collection. For multi-step agent work use gridflow_openWorkflow.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        templateId: { type: 'string', description: "Built-in: 'subagent-orchestration', 'api-endpoints', 'test-cases'." },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['text', 'select', 'number', 'boolean'] },
              options: { type: 'array', items: { type: 'string' } },
              placeholder: { type: 'string' },
            },
          },
        },
        rows: { type: 'array', items: { type: 'object' } },
        instructions: { type: 'string' },
      },
    },
  },
];
