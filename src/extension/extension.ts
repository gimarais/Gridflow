import * as vscode from 'vscode';
import { GridPanel } from './gridPanel';
import { TemplateService } from './templates';
import { TemplateManagerPanel } from './templateManagerPanel';
import { CsvEditorProvider } from './csvEditor';
import * as fs from 'fs';
import * as nodePath from 'path';
import * as os from 'os';
import { registerLanguageModelTool } from './lmTool';
import { registerChatParticipant, ORCHESTRATOR_SYSTEM_PROMPT } from './chatParticipant';
import { GridFlowMcpServer } from './mcpServer';
import { WorkflowOrchestrator } from './workflowOrchestrator';
import { PROXY_SCRIPT } from './proxyScript';
import { GridSnapshot, RowData, makeId } from '../shared/types';
import { listWorkflows } from './workflowStore';

export async function activate(context: vscode.ExtensionContext) {
  const templates = new TemplateService(context);

  // The orchestrator owns all workflow logic, shared by the MCP server (Claude) and
  // the language-model tools (Copilot) so both surfaces behave identically.
  const orchestrator = new WorkflowOrchestrator(context, templates);

  // Start the MCP server so Claude Code / the desktop app can drive workflows.
  let mcpServer: GridFlowMcpServer | null = null;
  const mcpPort = vscode.workspace.getConfiguration('gridflow').get<number>('mcpPort', 54321);
  if (mcpPort > 0) {
    mcpServer = new GridFlowMcpServer(context, templates, mcpPort, orchestrator);
    try {
      await mcpServer.start();
      context.subscriptions.push({ dispose: () => mcpServer!.stop() });
      console.log(`GridFlow: MCP server listening on http://127.0.0.1:${mcpPort}/sse`);
      // Write the stdio proxy, port file, and capability token so the Claude desktop
      // app can connect (the token gates the server against browser-driven access).
      installProxy(mcpPort, mcpServer.token);
    } catch (err) {
      console.warn(`GridFlow: MCP server failed to start on port ${mcpPort}:`, err);
      vscode.window.showWarningMessage(
        `GridFlow: MCP server could not start on port ${mcpPort} (port in use?). ` +
        `Change gridflow.mcpPort in settings, or set it to 0 to disable.`,
      );
      mcpServer = null;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('gridflow.open', () => openStandalone(context, templates)),
    vscode.commands.registerCommand('gridflow.openWithTemplate', async () => {
      const all = await templates.list();
      const pick = await vscode.window.showQuickPick(
        all.map((t) => ({
          label: t.name,
          description: t.scope === 'builtin' ? 'Built-in' : t.scope,
          detail: t.description,
          template: t,
        })),
        { placeHolder: 'Pick a template' },
      );
      if (!pick) return;
      await openStandalone(context, templates, pick.template.id);
    }),
    vscode.commands.registerCommand('gridflow.openWorkflow', () => openWorkflow(orchestrator)),
    vscode.commands.registerCommand('gridflow.manageTemplates', () => {
      TemplateManagerPanel.show(context, templates, (templateId) => {
        openStandalone(context, templates, templateId);
      });
    }),
    vscode.commands.registerCommand('gridflow.openCsv', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Open a CSV file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, CsvEditorProvider.viewType);
    }),
    vscode.commands.registerCommand('gridflow.openCsvFromExplorer', async (uri: vscode.Uri) => {
      if (!uri) return;
      await vscode.commands.executeCommand('vscode.openWith', uri, CsvEditorProvider.viewType);
    }),
    vscode.commands.registerCommand('gridflow.showMcpConfig', () => {
      if (mcpServer) showMcpConfig(mcpServer.port);
      else vscode.window.showWarningMessage('GridFlow MCP server is not running. Check the gridflow.mcpPort setting.');
    }),
    vscode.commands.registerCommand('gridflow.configureDesktopApp', () => {
      if (mcpServer) configureDesktopApp(mcpServer.port, mcpServer.token);
      else vscode.window.showWarningMessage('GridFlow MCP server is not running. Press F5 to start the Extension Development Host first.');
    }),
    vscode.commands.registerCommand('gridflow.openWorkflowFromFile', async (uri: vscode.Uri) => {
      if (!uri) return;
      const slug = nodePath.basename(uri.fsPath, '.json');
      try {
        await orchestrator.openWorkflow({ name: slug }, { blocking: false });
      } catch (err) {
        vscode.window.showErrorMessage(`GridFlow: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context, templates),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  // Language Model Tools API is only present in newer VS Code versions; guard the call.
  if (typeof vscode.lm?.registerTool === 'function') {
    try {
      context.subscriptions.push(registerLanguageModelTool(context, templates, orchestrator));
      console.log('GridFlow: LM tools registered for Copilot (openWorkflow, updateRow, getWorkflow, collectStructuredInput).');
    } catch (err) {
      console.error('GridFlow: failed to register language model tool', err);
    }
  }

  // Chat participant (@gridflow) — natural language interface for VS Code Chat / Copilot.
  // Guards internally for VS Code versions that don't yet expose vscode.chat.
  try {
    const participant = registerChatParticipant(context);
    if (participant) {
      console.log('GridFlow: @gridflow chat participant registered.');
    }
  } catch (err) {
    console.error('GridFlow: failed to register chat participant', err);
  }

  // Write a Claude Code agent definition so the gridflow orchestrator is available
  // as a sub-agent in Claude Code sessions (requires MCP to be connected).
  installClaudeAgent();
}

export function deactivate() {
  // Nothing to clean up — all disposables are owned by the extension context.
}

/**
 * The Node runtime used to launch the stdio MCP proxy. We point at VS Code's own
 * Electron binary with ELECTRON_RUN_AS_NODE=1 — it always exists on every platform,
 * unlike a hardcoded '/opt/homebrew/bin/node' which only resolves on Homebrew Macs.
 */
function nodeRuntime(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Write the stdio proxy script, port file, and capability token so desktop MCP clients can connect. */
function installProxy(port: number, token: string): void {
  try {
    const dir = nodePath.join(os.homedir(), '.gridflow');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(nodePath.join(dir, 'proxy.js'), PROXY_SCRIPT, 'utf8');
    fs.writeFileSync(nodePath.join(dir, 'current-port'), String(port), 'utf8');
    // The token is a capability that grants access to the local MCP server — it must
    // be readable only by the current user. writeFileSync's mode is ignored when the
    // file already exists, so chmod explicitly to enforce 0600 on every write.
    const tokenPath = nodePath.join(dir, 'token');
    fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort (e.g. Windows) */ }
  } catch (err) {
    console.warn('GridFlow: could not write proxy script:', err);
  }
}

/**
 * Write a Claude Code agent definition to ~/.claude/agents/gridflow.md so the
 * GridFlow orchestrator is available as a named sub-agent in Claude Code sessions.
 * Only writes if ~/.claude/agents/ already exists (meaning Claude Code is installed).
 */
function installClaudeAgent(): void {
  const agentsDir = nodePath.join(os.homedir(), '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) return;

  const agentFile = nodePath.join(agentsDir, 'gridflow.md');
  const content = [
    '---',
    'name: GridFlow Orchestrator',
    'description: >',
    '  Use this agent to orchestrate sub-agents through GridFlow — opening workflow grids,',
    '  dispatching parallel/sequential tasks, and reporting provenance back to the panel.',
    '  Invoke when the user wants a multi-step workflow, wants to coordinate agents, wants',
    '  to track work in a structured dashboard, or asks to "use GridFlow".',
    '---',
    '',
    ORCHESTRATOR_SYSTEM_PROMPT,
  ].join('\n');

  try {
    // Only overwrite if the file doesn't exist or differs — avoid unnecessary writes.
    const existing = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8') : null;
    if (existing !== content) {
      fs.writeFileSync(agentFile, content, 'utf8');
      console.log(`GridFlow: Claude Code agent definition written to ${agentFile}`);
    }
  } catch (err) {
    console.warn('GridFlow: could not write Claude Code agent file:', err);
  }
}

/**
 * Auto-write the gridflow entry into ~/Library/Application Support/Claude/claude_desktop_config.json
 * so the Claude desktop app can spawn the stdio proxy.
 */
function configureDesktopApp(port: number, token: string): void {
  installProxy(port, token);

  const proxyPath = nodePath.join(os.homedir(), '.gridflow', 'proxy.js');

  // Use the bundled Claude CLI to register — writes to ~/.claude.json mcpServers
  // which is what the Claude Code VS Code extension actually reads.
  const claudeBin = findClaudeBin();

  const { command: nodeCmd, env: nodeEnv } = nodeRuntime();
  const entry = JSON.stringify({ type: 'stdio', command: nodeCmd, args: [proxyPath], env: nodeEnv });
  const args = ['mcp', 'add-json', 'gridflow', entry, '-s', 'user'];

  let registered = false;
  if (claudeBin) {
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process');
      execFileSync(claudeBin, args, { encoding: 'utf8' });
      registered = true;
    } catch {
      // fall through to manual instructions
    }
  }

  if (registered) {
    vscode.window.showInformationMessage(
      'GridFlow registered with Claude Code. Run Developer: Reload Window then try: Use gridflow_openWorkflow to create a workflow.',
    );
  } else {
    // Fallback: write directly to claude_desktop_config.json
    const configPath = nodePath.join(
      os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json',
    );
    try {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* new file */ }
      const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
      servers['gridflow'] = { command: nodeCmd, args: [proxyPath], env: nodeEnv };
      config['mcpServers'] = servers;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      vscode.window.showInformationMessage(
        'GridFlow added to Claude desktop config. Restart the Claude desktop app.',
        'Open File',
      ).then((c) => { if (c === 'Open File') vscode.env.openExternal(vscode.Uri.file(configPath)); });
    } catch (err) {
      vscode.window.showErrorMessage(`Could not configure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function findClaudeBin(): string | null {
  // Try common locations for the Claude CLI binary.
  const candidates = [
    'claude', // in PATH
    nodePath.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.156', 'claude.app', 'Contents', 'MacOS', 'claude'),
    '/usr/local/bin/claude',
    nodePath.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try {
      if (c === 'claude') {
        const { execFileSync } = require('child_process') as typeof import('child_process');
        execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000 });
        return 'claude';
      } else if (fs.existsSync(c)) {
        return c;
      }
    } catch { /* not found */ }
  }
  return null;
}

function showMcpConfig(_port: number): void {
  const proxyPath = nodePath.join(os.homedir(), '.gridflow', 'proxy.js');

  // The correct command — writes to ~/.claude.json mcpServers, which both the CLI
  // and the Claude Code VS Code extension read from.
  const { command: nodeCmd, env: nodeEnv } = nodeRuntime();
  const serverJson = JSON.stringify({ type: 'stdio', command: nodeCmd, args: [proxyPath], env: nodeEnv });
  const registerCmd = `claude mcp add-json gridflow '${serverJson}' -s user`;
  // macOS path to the bundled Claude CLI (adjust version as needed)
  const claudeBin = nodePath.join(
    os.homedir(),
    'Library', 'Application Support', 'Claude', 'claude-code',
    '2.1.156', 'claude.app', 'Contents', 'MacOS', 'claude',
  );
  const registerCmdFull = `"${claudeBin}" mcp add-json gridflow '${serverJson}' -s user`;

  const panel = vscode.window.createWebviewPanel(
    'gridflow.mcpConfig',
    'GridFlow: MCP Configuration',
    vscode.ViewColumn.Active,
    { enableScripts: false },
  );
  panel.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family,sans-serif); font-size:13px; padding:24px 32px; color:var(--vscode-editor-foreground); background:var(--vscode-editor-background); }
  h2 { margin-top:0; }
  pre { background:var(--vscode-textCodeBlock-background,#1e1e1e); border-radius:4px; padding:12px 16px; overflow:auto; font-family:var(--vscode-editor-font-family,monospace); font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .label { font-weight:600; margin-bottom:4px; }
  .section { margin-bottom:24px; }
  p { line-height:1.6; }
  code { background:var(--vscode-textCodeBlock-background,#1e1e1e); padding:1px 5px; border-radius:3px; font-family:var(--vscode-editor-font-family,monospace); }
</style></head><body>
<h2>Connect Claude Code to GridFlow via MCP</h2>

<div class="section">
  <div class="label">Step 1 — Register (if <code>claude</code> is in PATH)</div>
  <pre>${registerCmd.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
  <div class="label">Step 1 — Register (using bundled Claude binary)</div>
  <pre>${registerCmdFull.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
  <p>This writes to <code>~/.claude.json</code> under <code>mcpServers</code> — the location both the Claude Code CLI and VS Code extension read from.</p>
</div>

<div class="section">
  <div class="label">Step 2 — Reload VS Code</div>
  <p>Run <code>Developer: Reload Window</code> in the Extension Development Host (Cmd+Shift+P).</p>
</div>

<div class="section">
  <div class="label">Step 3 — Verify</div>
  <pre>claude mcp list   # should show gridflow: ✓ Connected</pre>
</div>

<div class="section">
  <div class="label">Then ask Claude Code:</div>
  <pre>Use gridflow_openWorkflow to create a new workflow called "my-task" with these rows: Research, Implement, Test, Review</pre>
</div>

<p style="opacity:0.7;font-size:11px;">GridFlow MCP server: port <code>gridflow.mcpPort</code> (default 54321). Proxy: <code>${proxyPath.replace(/</g,'&lt;')}</code></p>
</body></html>`;
}

async function openStandalone(
  context: vscode.ExtensionContext,
  templates: TemplateService,
  templateId?: string,
): Promise<void> {
  const id = templateId ?? vscode.workspace.getConfiguration('gridflow').get<string>('defaultTemplate', 'subagent-orchestration');
  const tpl = await templates.get(id);
  const snapshot: GridSnapshot = tpl
    ? {
        title: tpl.name,
        columns: tpl.columns,
        rows: (tpl.seedRows ?? [{} as RowData]).map((cells) => ({
          id: makeId('row'),
          cells: normalizeCells(tpl.columns, cells),
        })),
      }
    : {
        title: 'Untitled Grid',
        columns: [{ id: makeId('col'), name: 'Value', type: 'text' }],
        rows: [{ id: makeId('row'), cells: {} }],
      };
  GridPanel.create(context, templates, {
    mode: 'standalone',
    title: snapshot.title ?? 'GridFlow',
    initialSnapshot: snapshot,
  });
}

/**
 * Open (or create) a workflow grid — rows are first-class work items, persisted to a
 * `.gridflow/<slug>.json` sidecar so status/provenance/logs/cost survive across sessions.
 */
/**
 * Palette command: open (or create) a workflow grid for manual editing. Non-blocking —
 * it does not wait for a submit, unlike the agent-invoked openWorkflow tool.
 */
async function openWorkflow(orchestrator: WorkflowOrchestrator): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage('Open a folder first — GridFlow workflows are saved in the workspace under .gridflow/.');
    return;
  }

  const existing = await listWorkflows();
  const NEW_ITEM = '$(add) New workflow…';
  const pick = await vscode.window.showQuickPick(
    [NEW_ITEM, ...existing.map((s) => `$(list-tree) ${s}`)],
    { placeHolder: existing.length ? 'Open a workflow or create a new one' : 'Name your first workflow' },
  );
  if (pick === undefined) return;

  let name: string;
  if (pick === NEW_ITEM || existing.length === 0) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Workflow name',
      placeHolder: 'e.g. Auth refactor',
      validateInput: (v) => (v.trim().length === 0 ? 'Enter a name' : undefined),
    });
    if (!entered) return;
    name = entered;
  } else {
    name = pick.replace(/^\$\([^)]*\)\s*/, '');
  }

  await orchestrator.openWorkflow({ name }, { blocking: false });
}

function normalizeCells(
  columns: { id: string; name: string; type: string }[],
  cells: RowData,
) {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    const raw = cells[col.id] ?? cells[col.name];
    if (raw === undefined || raw === null) {
      out[col.id] = col.type === 'boolean' ? false : col.type === 'number' ? null : '';
    } else {
      out[col.id] = raw;
    }
  }
  return out as Record<string, string | number | boolean | null>;
}
