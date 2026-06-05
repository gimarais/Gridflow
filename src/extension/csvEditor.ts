import * as vscode from 'vscode';
import { GridPanel } from './gridPanel';
import { TemplateService } from './templates';
import { detectDelimiter, parseCsv, serializeCsv } from './csv';
import { GridSnapshot } from '../shared/types';

/**
 * Custom editor for .csv/.tsv files. The grid renders the document; edits flow back
 * through a WorkspaceEdit so VS Code's dirty/save/undo machinery stays intact.
 */
export class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'gridflow.csvEditor';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void | Thenable<void> {
    const delim = this.delimiter();
    let lastSerialized = document.getText();

    const buildSnapshot = (): GridSnapshot => {
      const text = document.getText();
      const detected = detectDelimiter(text, delim);
      const parsed = parseCsv(text, detected);
      return {
        title: document.fileName.split(/[\\/]/).pop(),
        columns: parsed.columns,
        rows: parsed.rows,
      };
    };

    const initial = buildSnapshot();

    const panel = GridPanel.attach(this.context, this.templates, webviewPanel, {
      mode: 'csv-editor',
      title: document.fileName.split(/[\\/]/).pop() ?? 'CSV',
      initialSnapshot: initial,
      onSnapshotChanged: async (snapshot) => {
        const effectiveDelim = delim === 'auto' ? detectDelimiter(document.getText(), delim) : delim;
        const text = serializeCsv(snapshot.columns, snapshot.rows, effectiveDelim);
        if (text === document.getText()) return;
        lastSerialized = text;
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          document.lineAt(document.lineCount - 1).range.end,
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, text);
        await vscode.workspace.applyEdit(edit);
      },
    });

    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.document.getText() === lastSerialized) return;
      panel.setSnapshot(buildSnapshot());
    });

    webviewPanel.onDidDispose(() => {
      docSub.dispose();
      panel.dispose();
    });
  }

  private delimiter(): string {
    return vscode.workspace.getConfiguration('gridflow').get<string>('csvDelimiter', 'auto');
  }
}
