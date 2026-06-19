import * as vscode from 'vscode';
import { BUILTIN_TEMPLATES } from '../shared/builtinTemplates';
import { ColumnDef, RowData, TemplateDef, makeId } from '../shared/types';

const WORKSPACE_FILE_RELATIVE = '.vscode/gridflow.templates.json';
const GLOBAL_STATE_KEY = 'gridflow.globalTemplates';
const HIDDEN_BUILTINS_KEY = 'gridflow.hiddenBuiltins';

interface StoredTemplate {
  id: string;
  name: string;
  description?: string;
  columns: ColumnDef[];
  seedRows?: RowData[];
}

export class TemplateService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async list(): Promise<TemplateDef[]> {
    const [workspace, global, hiddenIds] = await Promise.all([
      this.readWorkspace(),
      this.readGlobal(),
      this.readHiddenBuiltins(),
    ]);
    return [
      ...BUILTIN_TEMPLATES.map((t) => hiddenIds.has(t.id) ? { ...t, hidden: true } : t),
      ...workspace.map((t): TemplateDef => ({ ...t, scope: 'workspace' })),
      ...global.map((t): TemplateDef => ({ ...t, scope: 'global' })),
    ];
  }

  async get(id: string): Promise<TemplateDef | undefined> {
    const all = await this.list();
    return all.find((t) => t.id === id);
  }

  async save(
    scope: 'workspace' | 'global',
    name: string,
    columns: ColumnDef[],
    seedRows: RowData[] | undefined,
    description: string | undefined,
  ): Promise<TemplateDef> {
    const tpl: StoredTemplate = {
      id: makeId('tpl'),
      name,
      description,
      columns,
      seedRows,
    };
    if (scope === 'workspace') {
      const existing = await this.readWorkspace();
      await this.writeWorkspace([...existing.filter((t) => t.name !== name), tpl]);
    } else {
      const existing = await this.readGlobal();
      await this.writeGlobal([...existing.filter((t) => t.name !== name), tpl]);
    }
    return { ...tpl, scope };
  }

  async rename(id: string, name: string, description?: string): Promise<void> {
    const [workspace, global] = await Promise.all([this.readWorkspace(), this.readGlobal()]);
    const wIdx = workspace.findIndex((t) => t.id === id);
    if (wIdx >= 0) {
      workspace[wIdx] = { ...workspace[wIdx], name, description };
      await this.writeWorkspace(workspace);
      return;
    }
    const gIdx = global.findIndex((t) => t.id === id);
    if (gIdx >= 0) {
      global[gIdx] = { ...global[gIdx], name, description };
      await this.writeGlobal(global);
    }
  }

  async delete(id: string): Promise<void> {
    const [workspace, global] = await Promise.all([this.readWorkspace(), this.readGlobal()]);
    if (workspace.some((t) => t.id === id)) {
      await this.writeWorkspace(workspace.filter((t) => t.id !== id));
      return;
    }
    if (global.some((t) => t.id === id)) {
      await this.writeGlobal(global.filter((t) => t.id !== id));
      return;
    }
  }

  async hideBuiltin(id: string): Promise<void> {
    const hidden = await this.readHiddenBuiltins();
    hidden.add(id);
    await this.context.globalState.update(HIDDEN_BUILTINS_KEY, Array.from(hidden));
  }

  async showBuiltin(id: string): Promise<void> {
    const hidden = await this.readHiddenBuiltins();
    hidden.delete(id);
    await this.context.globalState.update(HIDDEN_BUILTINS_KEY, Array.from(hidden));
  }

  /* ------------------------------------------------------------ */

  private async readHiddenBuiltins(): Promise<Set<string>> {
    const stored = this.context.globalState.get<string[]>(HIDDEN_BUILTINS_KEY, []);
    return new Set(stored);
  }

  private workspaceUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return vscode.Uri.joinPath(folder.uri, WORKSPACE_FILE_RELATIVE);
  }

  private async readWorkspace(): Promise<StoredTemplate[]> {
    const uri = this.workspaceUri();
    if (!uri) return [];
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(new TextDecoder().decode(buf));
      if (!Array.isArray(parsed)) return [];
      // The workspace template file ships with the repo — validate its shape so
      // a malformed or hostile file can't crash template listing or the grid.
      return parsed.filter(
        (t): t is StoredTemplate =>
          !!t && typeof t === 'object' &&
          typeof (t as StoredTemplate).id === 'string' &&
          typeof (t as StoredTemplate).name === 'string' &&
          Array.isArray((t as StoredTemplate).columns),
      );
    } catch {
      return [];
    }
  }

  private async writeWorkspace(templates: StoredTemplate[]): Promise<void> {
    const uri = this.workspaceUri();
    if (!uri) {
      throw new Error('No workspace folder is open — cannot save a workspace-scoped template.');
    }
    const folderUri = vscode.Uri.joinPath(uri, '..');
    try {
      await vscode.workspace.fs.createDirectory(folderUri);
    } catch {
      // already exists
    }
    const json = JSON.stringify(templates, null, 2);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(json));
  }

  private async readGlobal(): Promise<StoredTemplate[]> {
    return this.context.globalState.get<StoredTemplate[]>(GLOBAL_STATE_KEY, []);
  }

  private async writeGlobal(templates: StoredTemplate[]): Promise<void> {
    await this.context.globalState.update(GLOBAL_STATE_KEY, templates);
  }
}
