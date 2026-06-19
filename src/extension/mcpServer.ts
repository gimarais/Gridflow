import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../shared/orchestratorPrompt';
import { MCP_PROMPTS, MCP_TOOLS } from '../shared/mcpSchemas';
import { renderDashboardHtml } from '../shared/dashboardHtml';
import { workflowStats, workflowToText } from '../shared/workflowCore';
import { GridPanel } from './gridPanel';
import { TemplateService } from './templates';
import { ColumnDef, GridSnapshot, RowData, makeId } from '../shared/types';
import { extractHashTokens } from './hashCompletions';
import { FEATURE_MCP_TOOLS } from './featureTools';
import { listWorkflows, loadWorkflow } from './workflowStore';
import {
  WorkflowOrchestrator,
  OpenWorkflowInput,
  UpdateRowInput,
  GetWorkflowInput,
  AddRowsInput,
  ReplayRowInput,
  FanOutInput,
} from './workflowOrchestrator';

const TOOL_TIMEOUT_MS = 30 * 60 * 1000;

/** Cap on a single MCP request body to avoid unbounded memory growth. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Cap concurrent SSE clients so a buggy/looping client can't exhaust sockets. */
const MAX_SSE_CLIENTS = 16;

export { MCP_PROMPTS, MCP_TOOLS };

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

type JsonRpcMessage = { id?: unknown; method: string; params?: unknown };

/**
 * Local HTTP server that exposes GridFlow beyond the webview:
 *
 *   MCP (agents — strict auth, no browser may connect):
 *     GET  /sse + POST /message — legacy HTTP+SSE transport (Claude desktop via stdio proxy)
 *     POST /mcp                 — Streamable HTTP transport (2025-03-26) for modern MCP
 *                                 clients (Claude Code, Gemini CLI, Codex, Cline, …) — no proxy needed
 *
 *   Read-only surfaces (token-gated, same-origin browser access allowed):
 *     GET /api/workflows[/:slug] — workflow state as JSON for external platforms
 *     GET /dashboard             — self-contained live web dashboard
 *
 * All workflow logic lives in the shared WorkflowOrchestrator so the MCP surface and
 * the Copilot LM-tool surface behave identically.
 */
export class GridFlowMcpServer {
  private server: http.Server | null = null;
  private sseClients = new Map<string, http.ServerResponse>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
    readonly port: number,
    private readonly orchestrator: WorkflowOrchestrator,
    /**
     * Capability token required on every authenticated request. Persisted to
     * ~/.gridflow/token (mode 0600) so HTTP-transport client configs survive
     * window reloads; the stdio proxy reads it fresh on each launch and sends
     * it as the `x-gridflow-token` header. Browsers cannot read that file, so
     * only a user who can already read local files (same trust domain) can
     * connect.
     */
    readonly token: string,
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

  dashboardUrl(): string {
    return `http://127.0.0.1:${this.port}/dashboard?token=${this.token}`;
  }

  /* ── HTTP routing ──────────────────────────────────────────────────── */

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    // No Access-Control-Allow-Origin is ever set: foreign web origins can
    // neither read responses nor pass authorize*() below.
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    // /health stays open (no sensitive data) so connectivity can be probed.
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'gridflow-mcp', version: '0.3.0' }));
      return;
    }

    // Read-only surfaces: token via header or query, same-origin browsers allowed.
    if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname.startsWith('/api/'))) {
      if (!this.authorizeRead(req, url)) { res.writeHead(403); res.end(); return; }
      if (url.pathname === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderDashboardHtml());
      } else {
        void this.handleApi(url, res);
      }
      return;
    }

    // MCP transports: strict auth (no browser may connect at all).
    if (!this.authorizeMcp(req)) { res.writeHead(403); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/sse') {
      this.handleSse(req, res);
    } else if (req.method === 'POST' && url.pathname === '/message') {
      this.handlePost(req, res, url.searchParams.get('sessionId') ?? '');
    } else if (req.method === 'POST' && url.pathname === '/mcp') {
      this.handleStreamableHttp(req, res);
    } else {
      res.writeHead(404); res.end();
    }
  }

  /**
   * Gate the MCP transports against browser-driven (CSRF) and DNS-rebinding attacks.
   * Legitimate clients (the stdio proxy, MCP CLIs) send no Origin, connect to
   * loopback, and carry the token header.
   */
  private authorizeMcp(req: http.IncomingMessage): boolean {
    // Any browser fetch / EventSource attaches an Origin header; reject those.
    if (req.headers.origin !== undefined) return false;
    if (!this.hostIsLoopback(req)) return false;
    const provided = req.headers['x-gridflow-token'];
    return typeof provided === 'string' && timingSafeEq(provided, this.token);
  }

  /**
   * Gate the read-only GET surfaces. Browsers are allowed (the dashboard runs
   * in one) but only same-origin: a foreign origin's fetch carries its own
   * Origin header and is rejected — and without CORS headers it couldn't read
   * the response anyway. The token may come via header or ?token= (the
   * dashboard URL embeds it, since browsers can't set headers on navigation).
   */
  private authorizeRead(req: http.IncomingMessage, url: URL): boolean {
    if (!this.hostIsLoopback(req)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && !this.isOwnOrigin(origin)) return false;
    const header = req.headers['x-gridflow-token'];
    if (typeof header === 'string') return timingSafeEq(header, this.token);
    const query = url.searchParams.get('token');
    return typeof query === 'string' && timingSafeEq(query, this.token);
  }

  private hostIsLoopback(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private isOwnOrigin(origin: string): boolean {
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  /* ── read-only JSON API ────────────────────────────────────────────── */

  private async handleApi(url: URL, res: http.ServerResponse): Promise<void> {
    try {
      if (url.pathname === '/api/workflows') {
        const slugs = await listWorkflows();
        const items = await Promise.all(
          slugs.map(async (slug) => {
            const snapshot = await loadWorkflow(slug);
            return snapshot
              ? { slug, title: snapshot.title ?? slug, stats: workflowStats(snapshot) }
              : null;
          }),
        );
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(items.filter((x) => x !== null)));
        return;
      }
      const match = url.pathname.match(/^\/api\/workflows\/([a-z0-9-]+)$/);
      if (match) {
        const snapshot = await loadWorkflow(match[1]);
        if (!snapshot) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(workflowToText(match[1], snapshot, 'current'));
        return;
      }
      res.writeHead(404); res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  /* ── legacy HTTP+SSE transport ─────────────────────────────────────── */

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      res.writeHead(503); res.end(); return;
    }
    const clientId = crypto.randomBytes(12).toString('hex');
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

  /** Read a request body, enforcing MAX_BODY_BYTES (413 + undefined when exceeded). */
  private readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | undefined> {
    return new Promise((resolve) => {
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
          resolve(undefined);
          return;
        }
        body += c.toString();
      });
      req.on('end', () => resolve(aborted ? undefined : body));
      req.on('error', () => resolve(undefined));
    });
  }

  private handlePost(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): void {
    void this.readBody(req, res).then(async (body) => {
      if (body === undefined) return;
      res.writeHead(202); res.end();
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(body); } catch { return; }
      const reply = await this.handle(msg);
      if (reply !== null) this.sendSse(clientId, reply);
    });
  }

  /* ── Streamable HTTP transport (2025-03-26) ────────────────────────── */

  /**
   * POST /mcp — each request gets its own SSE-framed response stream, so
   * long-blocking tools (openWorkflow waits for "Start Workflow") work without
   * a separate event channel or the stdio proxy. Stateless: no session ids.
   */
  private handleStreamableHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    void this.readBody(req, res).then(async (body) => {
      if (body === undefined) return;
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[];
      const hasRequest = messages.some((m) => m && typeof m === 'object' && m.id !== undefined);
      if (!hasRequest) {
        // Notifications / responses only — acknowledge with no body.
        for (const m of messages) void this.handle(m);
        res.writeHead(202); res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      for (const m of messages) {
        const reply = await this.handle(m);
        if (reply !== null) res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
      res.end();
    });
  }

  /* ── MCP method dispatch ───────────────────────────────────────────── */

  private async handle(msg: JsonRpcMessage): Promise<unknown> {
    const id = (msg.id !== undefined ? msg.id : null) as string | number | null;

    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: 'gridflow', version: '0.3.0' },
          },
        };

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list': {
        const featureTools = FEATURE_MCP_TOOLS.map((t) => t.schema);
        return { jsonrpc: '2.0', id, result: { tools: [...MCP_TOOLS, ...featureTools] } };
      }

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
            case 'gridflow_fanOut':
              text = await this.orchestrator.fanOut(args as unknown as FanOutInput);
              break;
            case 'gridflow_updateRow':
              text = await this.orchestrator.updateRow(args as unknown as UpdateRowInput);
              break;
            case 'gridflow_getWorkflow':
              text = await this.orchestrator.getWorkflow(args as unknown as GetWorkflowInput);
              break;
            case 'gridflow_replayRow':
              text = await this.orchestrator.replayRow(args as unknown as ReplayRowInput);
              break;
            case 'gridflow_collectStructuredInput':
              text = await this.invokeCollectInput(args as unknown as CollectInput);
              break;
            default: {
              // Dispatch to a feature-contributed tool (verifier, advisor, governance).
              const featureTool = FEATURE_MCP_TOOLS.find(
                (t) => (t.schema as { name?: string })?.name === p?.name,
              );
              if (featureTool) {
                text = await featureTool.handler(args);
                break;
              }
              return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${p?.name}` } };
            }
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
