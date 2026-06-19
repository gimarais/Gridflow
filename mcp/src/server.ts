/**
 * @gridflow/mcp — HTTP server exposing GridFlow workflows via MCP protocol
 *
 * Runs the same MCP tools as the VS Code extension (shared schemas + shared
 * workflow core, same sidecar files) as a headless HTTP server. Claude Code
 * or any MCP client can orchestrate workflows via HTTP + SSE.
 *
 * Usage:
 *   const server = await startMcpServer({ port: 54321, workflowDir: '/path/to/.gridflow' });
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

export interface McpServerOptions {
  port: number;
  workflowDir: string;
}

export interface McpServerResult {
  token: string;
  port: number;
  workflowDir: string;
}

// Re-export shared types so mcp consumers don't need to import from src/shared
export type { GridSnapshot, Provenance } from '../../src/shared/types';
export type { UpdateRowInput, WorkflowColumnInput, WorkflowRowInput } from '../../src/shared/workflowCore';
export {
  applyRowUpdate,
  budgetStatus,
  buildColumns,
  buildFanOut,
  buildRows,
  dispatchPlan,
  emptyCells,
  fileRiskWarnings,
  prepareReplay,
  readyRowIds,
  readyRowsDetail,
  resolveRowInputs,
  riskyRows,
  slugify,
  staleRowIds,
  workflowStats,
  workflowToText,
} from '../../src/shared/workflowCore';
export { MCP_PROMPTS, MCP_TOOLS } from '../../src/shared/mcpSchemas';
export { ORCHESTRATOR_SYSTEM_PROMPT } from '../../src/shared/orchestratorPrompt';
export { renderDashboardHtml } from '../../src/shared/dashboardHtml';
export { verifyProvenance } from '../../src/shared/provenanceCore';

// Import from src/shared
import { GridSnapshot, Provenance, emptyWorkItem, makeId } from '../../src/shared/types';
import {
  applyRowUpdate,
  buildColumns,
  buildFanOut,
  buildRows,
  dispatchPlan,
  emptyCells,
  prepareReplay,
  readyRowIds,
  riskyRows,
  slugify,
  staleRowIds,
  workflowStats,
  workflowToText,
  FanOutItem,
  UpdateRowInput,
  WorkflowColumnInput,
  WorkflowRowInput,
} from '../../src/shared/workflowCore';
import { MCP_PROMPTS, MCP_TOOLS } from '../../src/shared/mcpSchemas';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../../src/shared/orchestratorPrompt';
import { renderDashboardHtml } from '../../src/shared/dashboardHtml';
import { verifyProvenance } from '../../src/shared/provenanceCore';
import {
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
  withWorkflowLock,
} from '../../cli/src/store';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SSE_CLIENTS = 16;

interface OpenWorkflowInput {
  name: string;
  title?: string;
  columns?: WorkflowColumnInput[];
  rows?: WorkflowRowInput[];
  instructions?: string;
}

type JsonRpcMessage = { id?: unknown; method: string; params?: unknown };

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Same token file the extension uses — one capability per user. */
function loadOrCreateToken(): string {
  const dir = path.join(os.homedir(), '.gridflow');
  const tokenPath = path.join(dir, 'token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(existing)) return existing;
  } catch { /* none yet */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
  return token;
}

export async function startMcpServer(opts: McpServerOptions): Promise<McpServerResult> {
  const workflowDir = opts.workflowDir;
  const workspaceRoot = path.dirname(workflowDir);
  const token = loadOrCreateToken();
  const port = opts.port;
  const sseClients = new Map<string, http.ServerResponse>();

  const stat = async (p: string) => {
    try {
      const s = await fs.promises.stat(p);
      return { mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  };

  /* ── tool implementations (headless) ─────────────────────────────── */

  async function openWorkflow(input: OpenWorkflowInput): Promise<string> {
    if (!input?.name) throw new Error('openWorkflow requires a "name".');
    const slug = slugify(input.name);
    return withWorkflowLock(slug, async () => {
      let snapshot = await loadWorkflow(workflowDir, slug);
      if (!snapshot) {
        const columns = buildColumns(input.columns);
        const rows = input.rows?.length
          ? buildRows(columns, input.rows).rows
          : [{ id: makeId('row'), cells: emptyCells(columns), work: emptyWorkItem() }];
        snapshot = { title: input.title ?? input.name, instructions: input.instructions, kind: 'workflow', columns, rows };
      } else if (input.rows?.length) {
        const built = buildRows(snapshot.columns, input.rows, snapshot.rows);
        snapshot = { ...snapshot, rows: [...snapshot.rows, ...built.rows] };
      }
      await saveWorkflow(workflowDir, slug, snapshot);
      return workflowToText(slug, snapshot, 'opened');
    });
  }

  async function addRows(input: { workflowId: string; rows: WorkflowRowInput[] }): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(workflowDir, slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const built = buildRows(snapshot.columns, input.rows ?? [], snapshot.rows);
      const updated: GridSnapshot = { ...snapshot, rows: [...snapshot.rows, ...built.rows] };
      await saveWorkflow(workflowDir, slug, updated);
      return workflowToText(slug, updated, 'rows-added');
    });
  }

  async function updateRow(input: UpdateRowInput): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(workflowDir, slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const row = snapshot.rows.find((r) => r.id === input.rowId);
      if (!row) throw new Error(`Row "${input.rowId}" not found in workflow "${slug}".`);

      let effectiveInput = input;
      let verification;
      if (input.provenance) {
        const openRun = (row.work?.history ?? []).find((r) => r.startedAt && !r.finishedAt);
        const verified = await verifyProvenance(input.provenance as Provenance, {
          workspaceRoot,
          stat,
          runStart: input.startedAt ?? openRun?.startedAt,
          runEnd: input.finishedAt ?? new Date().toISOString(),
        });
        verification = verified.summary;
        effectiveInput = { ...input, provenance: verified.provenance as UpdateRowInput['provenance'] };
      }

      const result = applyRowUpdate(snapshot, effectiveInput);
      await saveWorkflow(workflowDir, slug, result.snapshot);

      const stale = staleRowIds(result.snapshot);
      const plan = dispatchPlan(result.snapshot);
      return JSON.stringify({
        ok: true,
        workflowId: slug,
        rowId: input.rowId,
        status: result.work.status,
        runsTotal: result.runsTotal,
        durationMs: result.totalDurationMs || undefined,
        totalTokens: result.totalTokens || undefined,
        totalCostUsd: result.totalCostUsd || undefined,
        verification,
        droppedDependencies: result.droppedDependencies.length ? result.droppedDependencies : undefined,
        readyRowIds: plan.readyRowIds,
        readyRows: plan.readyRows,
        budgetExceeded: plan.budgetExceeded || undefined,
        budget: result.snapshot.budget ? plan.budget : undefined,
        staleRowIds: stale.length ? stale : undefined,
        riskyRows: riskyRows(result.snapshot).length ? riskyRows(result.snapshot) : undefined,
      }, null, 2);
    });
  }

  async function fanOut(input: { workflowId: string; template: WorkflowRowInput; items: FanOutItem[] }): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(workflowDir, slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const built = buildFanOut(snapshot.columns, input.template ?? {}, input.items ?? [], snapshot.rows);
      const updated: GridSnapshot = { ...snapshot, rows: [...snapshot.rows, ...built.rows] };
      await saveWorkflow(workflowDir, slug, updated);
      return workflowToText(slug, updated, 'rows-added');
    });
  }

  async function replayRow(input: { workflowId: string; rowId: string; promptOverride?: string }): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(workflowDir, slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const { snapshot: next, resolvedInputs } = prepareReplay(snapshot, input.rowId, {
        promptOverride: input.promptOverride,
      });
      await saveWorkflow(workflowDir, slug, next);
      return JSON.stringify({
        ok: true,
        workflowId: slug,
        rowId: input.rowId,
        status: 'pending',
        resolvedInputs,
        readyRowIds: readyRowIds(next),
      }, null, 2);
    });
  }

  async function getWorkflow(input: { workflowId: string }): Promise<string> {
    const slug = slugify(input.workflowId);
    const snapshot = await loadWorkflow(workflowDir, slug);
    if (!snapshot) throw new Error(`Workflow "${slug}" not found.`);
    return workflowToText(slug, snapshot, 'current');
  }

  /* ── JSON-RPC dispatch (mirrors the extension server) ────────────── */

  async function handle(msg: JsonRpcMessage): Promise<unknown> {
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
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } };
      case 'prompts/get': {
        const { name, arguments: args = {} } = (msg.params ?? {}) as { name?: string; arguments?: Record<string, string> };
        const prompt = MCP_PROMPTS.find((p) => p.name === name);
        if (!prompt) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Prompt "${name}" not found.` } };
        const task = args['task'] ? `\n\nThe user's task: ${args['task']}` : '';
        return {
          jsonrpc: '2.0', id,
          result: {
            description: prompt.description,
            messages: [{
              role: 'user',
              content: {
                type: 'text',
                text: `${ORCHESTRATOR_SYSTEM_PROMPT}${task}\n\nYou are now operating as the GridFlow orchestrator (headless — workflows start immediately, no Start Workflow confirmation). Respond to the user's first message.`,
              },
            }],
          },
        };
      }
      case 'tools/call': {
        const p = msg.params as { name: string; arguments?: Record<string, unknown> };
        const args = (p?.arguments ?? {}) as Record<string, unknown>;
        try {
          let text: string;
          switch (p?.name) {
            case 'gridflow_openWorkflow':
              text = await openWorkflow(args as unknown as OpenWorkflowInput);
              break;
            case 'gridflow_addRows':
              text = await addRows(args as unknown as { workflowId: string; rows: WorkflowRowInput[] });
              break;
            case 'gridflow_fanOut':
              text = await fanOut(args as unknown as { workflowId: string; template: WorkflowRowInput; items: FanOutItem[] });
              break;
            case 'gridflow_updateRow':
              text = await updateRow(args as unknown as UpdateRowInput);
              break;
            case 'gridflow_getWorkflow':
              text = await getWorkflow(args as unknown as { workflowId: string });
              break;
            case 'gridflow_replayRow':
              text = await replayRow(args as unknown as { workflowId: string; rowId: string; promptOverride?: string });
              break;
            case 'gridflow_collectStructuredInput':
              throw new Error('gridflow_collectStructuredInput needs the VS Code panel — unavailable in headless mode.');
            default:
              return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${p?.name}` } };
          }
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
        } catch (err) {
          return { jsonrpc: '2.0', id, error: { code: -32000, message: String(err instanceof Error ? err.message : err) } };
        }
      }
      default:
        if (id !== null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
        return null;
    }
  }

  /* ── HTTP plumbing ───────────────────────────────────────────────── */

  function hostIsLoopback(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }
  function isOwnOrigin(origin: string): boolean {
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }
  function authorizeMcp(req: http.IncomingMessage): boolean {
    if (req.headers.origin !== undefined) return false;
    if (!hostIsLoopback(req)) return false;
    const provided = req.headers['x-gridflow-token'];
    return typeof provided === 'string' && timingSafeEq(provided, token);
  }
  function authorizeRead(req: http.IncomingMessage, url: URL): boolean {
    if (!hostIsLoopback(req)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && !isOwnOrigin(origin)) return false;
    const header = req.headers['x-gridflow-token'];
    if (typeof header === 'string') return timingSafeEq(header, token);
    const query = url.searchParams.get('token');
    return typeof query === 'string' && timingSafeEq(query, token);
  }

  function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | undefined> {
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

  async function handleApi(url: URL, res: http.ServerResponse): Promise<void> {
    if (url.pathname === '/api/workflows') {
      const slugs = await listWorkflows(workflowDir);
      const items = [];
      for (const slug of slugs) {
        const snapshot = await loadWorkflow(workflowDir, slug);
        if (snapshot) items.push({ slug, title: snapshot.title ?? slug, stats: workflowStats(snapshot) });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(items));
      return;
    }
    const match = url.pathname.match(/^\/api\/workflows\/([a-z0-9-]+)$/);
    if (match) {
      const snapshot = await loadWorkflow(workflowDir, match[1]);
      if (!snapshot) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(workflowToText(match[1], snapshot, 'current'));
      return;
    }
    res.writeHead(404); res.end();
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'gridflow-mcp', version: '0.3.0' }));
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname.startsWith('/api/'))) {
      if (!authorizeRead(req, url)) { res.writeHead(403); res.end(); return; }
      if (url.pathname === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderDashboardHtml());
      } else {
        void handleApi(url, res).catch(() => { res.writeHead(500); res.end(); });
      }
      return;
    }

    if (!authorizeMcp(req)) { res.writeHead(403); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/sse') {
      if (sseClients.size >= MAX_SSE_CLIENTS) { res.writeHead(503); res.end(); return; }
      const clientId = crypto.randomBytes(12).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      sseClients.set(clientId, res);
      res.write(`event: endpoint\ndata: http://127.0.0.1:${port}/message?sessionId=${clientId}\n\n`);
      req.on('close', () => sseClients.delete(clientId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      const clientId = url.searchParams.get('sessionId') ?? '';
      void readBody(req, res).then(async (body) => {
        if (body === undefined) return;
        res.writeHead(202); res.end();
        let msg: JsonRpcMessage;
        try { msg = JSON.parse(body); } catch { return; }
        const reply = await handle(msg);
        if (reply !== null) sseClients.get(clientId)?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      void readBody(req, res).then(async (body) => {
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
          for (const m of messages) void handle(m);
          res.writeHead(202); res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        for (const m of messages) {
          const reply = await handle(m);
          if (reply !== null) res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        }
        res.end();
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use — GridFlow may already be running on this port.\n` +
          `Use another port: --port ${port + 1}`,
        ));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`GridFlow MCP server listening on http://127.0.0.1:${port}`);
      console.log(`  workflows:  ${workflowDir}`);
      console.log(`  dashboard:  http://127.0.0.1:${port}/dashboard?token=${token}`);
      console.log(`  MCP (http): http://127.0.0.1:${port}/mcp   (header x-gridflow-token: ~/.gridflow/token)`);
      console.log(`\nRegister with Claude Code:`);
      console.log(`  claude mcp add --transport http gridflow http://127.0.0.1:${port}/mcp --header "x-gridflow-token: ${token}" -s user`);
      resolve({ token, port, workflowDir });
    });
  });
}
