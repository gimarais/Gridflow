import * as vscode from 'vscode';
import { GridMode, GridSnapshot, HostToWebview, WebviewToHost, makeId } from '../shared/types';
import { TemplateService } from './templates';
import { detectDelimiter, parseCsv, serializeCsv } from './csv';
import { renderWebviewHtml } from './webviewHtml';
import { slugify, workflowToMarkdown } from '../shared/workflowCore';

export interface GridPanelOptions {
  title: string;
  mode: GridMode;
  initialSnapshot: GridSnapshot;
  /** When provided, the webview shows a "Send to Chat" action that resolves this callback. */
  onSendToChat?: (snapshot: GridSnapshot) => Thenable<void> | void;
  /** Called on every grid mutation. Used by the CSV editor to write back to disk. */
  onSnapshotChanged?: (snapshot: GridSnapshot) => Thenable<void> | void;
  /** Used for standalone mode; ignored when an existing panel is passed in. */
  viewColumn?: vscode.ViewColumn;
  /** True when the pro compliance module is recording a tamper-evident audit chain. */
  auditChain?: boolean;
}

export class GridPanel {
  readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private snapshot: GridSnapshot;
  private readonly mode: GridMode;
  private readonly onSendToChat?: GridPanelOptions['onSendToChat'];
  private readonly onSnapshotChanged?: GridPanelOptions['onSnapshotChanged'];
  private readonly auditChain: boolean;
  private readonly ownsPanel: boolean;
  private isReady = false;

  /**
   * Create a new panel. The grid manages the panel's lifecycle.
   */
  static create(
    context: vscode.ExtensionContext,
    templates: TemplateService,
    options: GridPanelOptions,
  ): GridPanel {
    const panel = vscode.window.createWebviewPanel(
      'gridflow.panel',
      options.title,
      options.viewColumn ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      },
    );
    return new GridPanel(context, templates, options, panel, true);
  }

  /**
   * Attach the grid to an existing webview panel — used by the CustomTextEditorProvider
   * where VS Code creates the panel and owns its lifecycle.
   */
  static attach(
    context: vscode.ExtensionContext,
    templates: TemplateService,
    panel: vscode.WebviewPanel,
    options: GridPanelOptions,
  ): GridPanel {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist'),
        vscode.Uri.joinPath(context.extensionUri, 'media'),
      ],
    };
    return new GridPanel(context, templates, options, panel, false);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
    options: GridPanelOptions,
    panel: vscode.WebviewPanel,
    ownsPanel: boolean,
  ) {
    this.snapshot = options.initialSnapshot;
    this.mode = options.mode;
    this.onSendToChat = options.onSendToChat;
    this.onSnapshotChanged = options.onSnapshotChanged;
    this.auditChain = options.auditChain ?? false;
    this.panel = panel;
    this.ownsPanel = ownsPanel;

    this.panel.webview.html = renderWebviewHtml(context, panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m as WebviewToHost)),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeActiveColorTheme(() => this.post({ type: 'themeChanged' })),
    );
  }

  setSnapshot(snapshot: GridSnapshot) {
    this.snapshot = snapshot;
    if (this.isReady) {
      this.post({ type: 'setSnapshot', snapshot });
    }
  }

  setPendingChatInvocation(pending: boolean) {
    this.post({ type: 'pendingChatInvocation', pending });
  }

  dispose() {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    if (this.ownsPanel) {
      // panel.dispose() triggers onDidDispose which already drained disposables above,
      // but calling here makes external dispose() consistent.
    }
  }

  /* -------------------------------------------------------------- */

  private post(message: HostToWebview) {
    this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToHost) {
    switch (message.type) {
      case 'ready': {
        this.isReady = true;
        this.post({
          type: 'init',
          snapshot: this.snapshot,
          mode: this.mode,
          canSendToChat: !!this.onSendToChat,
          auditChain: this.auditChain,
        });
        return;
      }
      case 'updateState': {
        this.snapshot = message.snapshot;
        if (this.onSnapshotChanged) {
          await this.onSnapshotChanged(message.snapshot);
        }
        return;
      }
      case 'requestTemplates': {
        const templates = await this.templates.list();
        this.post({ type: 'templates', templates });
        return;
      }
      case 'applyTemplate': {
        const tpl = await this.templates.get(message.templateId);
        if (!tpl) {
          vscode.window.showWarningMessage(`Template "${message.templateId}" not found.`);
          return;
        }
        const rows = (tpl.seedRows ?? [{}]).map((cells) => {
          const normalized: typeof cells = {};
          for (const col of tpl.columns) {
            const raw = cells[col.id] ?? cells[col.name];
            normalized[col.id] =
              raw ?? (col.type === 'boolean' ? false : col.type === 'number' ? null : '');
          }
          return { id: makeId('row'), cells: normalized };
        });
        const snapshot: GridSnapshot = {
          ...this.snapshot,
          columns: tpl.columns,
          rows,
        };
        this.snapshot = snapshot;
        this.post({ type: 'setSnapshot', snapshot });
        return;
      }
      case 'saveTemplate': {
        try {
          await this.templates.save(
            message.scope,
            message.name,
            message.columns,
            message.seedRows,
            message.description,
          );
          const templates = await this.templates.list();
          this.post({ type: 'templates', templates });
          vscode.window.showInformationMessage(`Template "${message.name}" saved (${message.scope}).`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to save template: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
      case 'deleteTemplate': {
        await this.templates.delete(message.templateId);
        const templates = await this.templates.list();
        this.post({ type: 'templates', templates });
        return;
      }
      case 'importCsvFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Import',
          filters: { 'CSV': ['csv', 'tsv', 'txt'] },
        });
        if (!uris || uris.length === 0) return;
        const buf = await vscode.workspace.fs.readFile(uris[0]);
        const text = new TextDecoder().decode(buf);
        const delim = detectDelimiter(text, this.getDelimiterSetting());
        const parsed = parseCsv(text, delim);
        this.post({ type: 'csvParsed', columns: parsed.columns, rows: parsed.rows });
        return;
      }
      case 'importCsvText': {
        const delim = detectDelimiter(message.text, this.getDelimiterSetting());
        const parsed = parseCsv(message.text, delim);
        this.post({ type: 'csvParsed', columns: parsed.columns, rows: parsed.rows });
        return;
      }
      case 'exportCsv': {
        const delim = this.getDelimiterSetting();
        const safe = vscode.workspace.getConfiguration('gridflow').get<boolean>('csvSafeExport', true);
        const text = serializeCsv(
          message.snapshot.columns,
          message.snapshot.rows,
          delim === 'auto' ? ',' : delim,
          { safe },
        );
        const uri = await vscode.window.showSaveDialog({
          filters: { 'CSV': ['csv'] },
          saveLabel: 'Export',
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        vscode.window.showInformationMessage(`Exported ${message.snapshot.rows.length} rows.`);
        return;
      }
      case 'exportWorkflowReport': {
        const slug = slugify(message.snapshot.title ?? 'workflow');
        const markdown = workflowToMarkdown(slug, message.snapshot);
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
          defaultUri: folder ? vscode.Uri.joinPath(folder, `${slug}-report.md`) : undefined,
          filters: { 'Markdown': ['md'] },
          saveLabel: 'Export Report',
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(markdown));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'openFilePicker': {
        const token = await openFilePickerQuickPick();
        this.post({ type: 'filePickerResult', token });
        return;
      }
      case 'sendToChat': {
        this.snapshot = message.snapshot;
        if (this.onSendToChat) {
          await this.onSendToChat(message.snapshot);
        }
        return;
      }
      case 'showError': {
        vscode.window.showErrorMessage(message.message);
        return;
      }
      case 'showInfo': {
        vscode.window.showInformationMessage(message.message);
        return;
      }
      case 'openTemplateManager': {
        await vscode.commands.executeCommand('gridflow.manageTemplates');
        return;
      }
    }
  }

  private getDelimiterSetting(): string {
    return vscode.workspace.getConfiguration('gridflow').get<string>('csvDelimiter', 'auto');
  }

}


const STATIC_PICKER_ITEMS: vscode.QuickPickItem[] = [
  { label: '$(repo) codebase', description: 'Entire workspace', detail: '#codebase' },
  { label: '$(warning) errors', description: 'Current workspace diagnostics', detail: '#errors' },
  { label: '$(edit) selection', description: 'Active editor selection', detail: '#selection' },
  { kind: vscode.QuickPickItemKind.Separator, label: 'Files' },
];

const FILE_PICKER_EXCLUDES = '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}';
const FILE_ITEMS_TTL_MS = 2000;
const fileItemsCache = new Map<string, { at: number; items: vscode.QuickPickItem[] }>();

async function buildFileItems(query: string): Promise<vscode.QuickPickItem[]> {
  const cached = fileItemsCache.get(query);
  if (cached && Date.now() - cached.at < FILE_ITEMS_TTL_MS) return cached.items;

  const pattern = query.length > 0 ? `**/*${query}*` : '**/*';
  try {
    const uris = await vscode.workspace.findFiles(pattern, FILE_PICKER_EXCLUDES, 200);
    const items = uris.map((uri) => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      return {
        label: `$(file) ${rel.split('/').pop() ?? rel}`,
        description: rel,
        detail: `#file:${rel}`,
      };
    });
    fileItemsCache.set(query, { at: Date.now(), items });
    return items;
  } catch {
    return [];
  }
}

function openFilePickerQuickPick(): Promise<string | null> {
  return new Promise(async (resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Type to search files — or pick #codebase, #errors, #selection';
    qp.matchOnDescription = true;
    qp.busy = true;

    // Load initial file list immediately.
    const initial = await buildFileItems('');
    qp.items = [...STATIC_PICKER_ITEMS, ...initial];
    qp.busy = false;

    let debounce: ReturnType<typeof setTimeout> | undefined;
    qp.onDidChangeValue((value) => {
      clearTimeout(debounce);
      qp.busy = true;
      debounce = setTimeout(async () => {
        const files = await buildFileItems(value);
        qp.items = [...STATIC_PICKER_ITEMS, ...files];
        qp.busy = false;
      }, 150);
    });

    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      resolve(picked?.detail ?? null);
      qp.dispose();
    });

    qp.onDidHide(() => {
      resolve(null);
      qp.dispose();
    });

    qp.show();
  });
}
