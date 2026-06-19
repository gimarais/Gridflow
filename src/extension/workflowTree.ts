import * as vscode from 'vscode';
import { workflowStats } from '../shared/workflowCore';
import { WORKFLOW_DIR, listWorkflows, loadWorkflow } from './workflowStore';

/**
 * Explorer tree view listing the workspace's `.gridflow/` workflows with live
 * status counts. Clicking an item opens (or reveals) the workflow panel.
 */
export class WorkflowTreeProvider implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly watcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, `${WORKFLOW_DIR}/*.json`),
      );
      this.watcher.onDidChange(() => this.refresh());
      this.watcher.onDidCreate(() => this.refresh());
      this.watcher.onDidDelete(() => this.refresh());
    }
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
  }

  getChildren(element?: string): Promise<string[]> {
    if (element) return Promise.resolve([]);
    return listWorkflows();
  }

  async getTreeItem(slug: string): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(slug, vscode.TreeItemCollapsibleState.None);
    item.command = {
      command: 'gridflow.openWorkflowFromTree',
      title: 'Open Workflow',
      arguments: [slug],
    };
    const snapshot = await loadWorkflow(slug);
    if (snapshot) {
      const stats = workflowStats(snapshot);
      item.label = snapshot.title ?? slug;
      item.description = `${stats.done}/${stats.total}` +
        (stats.running ? ` · ${stats.running} running` : '') +
        (stats.failed ? ` · ${stats.failed} failed` : '');
      item.iconPath = new vscode.ThemeIcon(
        stats.running ? 'sync~spin' : stats.failed ? 'error' : stats.done === stats.total && stats.total > 0 ? 'pass' : 'list-tree',
      );
      item.tooltip = new vscode.MarkdownString(
        `**${snapshot.title ?? slug}**\n\n` +
        `${stats.done}/${stats.total} done` +
        (stats.totalCostUsd ? ` · $${stats.totalCostUsd.toFixed(4)} (est.)` : '') +
        (stats.totalTokens ? ` · ${stats.totalTokens.toLocaleString()} tokens (est.)` : ''),
      );
    } else {
      item.iconPath = new vscode.ThemeIcon('list-tree');
    }
    return item;
  }
}
