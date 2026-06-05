import * as vscode from 'vscode';
import { GridSnapshot, HostToWebview, WebviewToHost } from '../shared/types';
import { TemplateService } from './templates';
import { renderWebviewHtml } from './webviewHtml';

const EMPTY_SNAPSHOT: GridSnapshot = { columns: [], rows: [] };

export class TemplateManagerPanel {
  private static current: TemplateManagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    templates: TemplateService,
    onOpenInGrid: (templateId: string) => void,
  ): void {
    if (TemplateManagerPanel.current) {
      TemplateManagerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    new TemplateManagerPanel(context, templates, onOpenInGrid);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
    private readonly onOpenInGrid: (templateId: string) => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'gridflow.templateManager',
      'GridFlow: Templates',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    TemplateManagerPanel.current = this;
    this.panel.webview.html = renderWebviewHtml(context, this.panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m as WebviewToHost)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private dispose() {
    TemplateManagerPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private post(message: HostToWebview) {
    this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToHost) {
    switch (message.type) {
      case 'ready': {
        this.post({ type: 'init', snapshot: EMPTY_SNAPSHOT, mode: 'template-manager', canSendToChat: false });
        return;
      }
      case 'requestTemplates': {
        const list = await this.templates.list();
        this.post({ type: 'templates', templates: list });
        return;
      }
      case 'deleteTemplate': {
        const all = await this.templates.list();
        const tpl = all.find((t) => t.id === message.templateId);
        if (!tpl || tpl.scope === 'builtin') return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete template "${tpl.name}"?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') return;
        await this.templates.delete(message.templateId);
        const updated = await this.templates.list();
        this.post({ type: 'templates', templates: updated });
        return;
      }
      case 'renameTemplate': {
        await this.templates.rename(message.id, message.name, message.description);
        const updated = await this.templates.list();
        this.post({ type: 'templates', templates: updated });
        return;
      }
      case 'openTemplateInGrid': {
        this.onOpenInGrid(message.templateId);
        return;
      }
      case 'hideBuiltin': {
        await this.templates.hideBuiltin(message.id);
        const updated = await this.templates.list();
        this.post({ type: 'templates', templates: updated });
        return;
      }
      case 'showBuiltin': {
        await this.templates.showBuiltin(message.id);
        const updated = await this.templates.list();
        this.post({ type: 'templates', templates: updated });
        return;
      }
    }
  }
}
