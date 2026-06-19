import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';

export function makeNonce(): string {
  // CSP nonce must be unpredictable — crypto-grade, not Math.random().
  return crypto.randomBytes(16).toString('base64url');
}

export function renderWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'),
  );
  const nonce = makeNonce();

  let inlineCss = '';
  try {
    const cssPath = nodePath.join(context.extensionUri.fsPath, 'dist', 'webview.css');
    inlineCss = fs.readFileSync(cssPath, 'utf8');
  } catch {
    inlineCss = `
      html, body, #root { height: 100%; margin: 0; padding: 0; }
      body { background: var(--vscode-editor-background, #1e1e1e);
             color: var(--vscode-editor-foreground, #d4d4d4);
             font-family: var(--vscode-font-family, sans-serif);
             font-size: var(--vscode-font-size, 13px); }
    `;
  }

  const csp = [
    `default-src 'none'`,
    // <style> elements need the nonce (blocks injected stylesheets); style
    // *attributes* (React style props, the error fallback) stay allowed via
    // the granular -attr directive — attributes can't load external resources.
    `style-src 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style nonce="${nonce}">${inlineCss}</style>
    <title>GridFlow</title>
  </head>
  <body>
    <div id="root"><div id="gridflow-preload" style="padding:16px;color:var(--vscode-editor-foreground,#d4d4d4)">Loading GridFlow…</div></div>
    <script nonce="${nonce}">
      window.__gridflowNonce = '${nonce}';
      window.onerror = function(msg, src, line, col, err) {
        var root = document.getElementById('root');
        if (!root) return;
        // Build via textContent — never innerHTML — so an error string can't inject markup.
        root.textContent = '';
        var box = document.createElement('div');
        box.setAttribute('style', 'padding:20px;font-family:monospace;color:#f48771');
        var title = document.createElement('b');
        title.textContent = 'GridFlow failed to load';
        var detail = document.createElement('pre');
        detail.textContent = String(err ? (err.stack || err) : msg);
        var hint = document.createElement('small');
        hint.textContent = 'Open Developer: Open Webview Developer Tools for details.';
        box.appendChild(title);
        box.appendChild(detail);
        box.appendChild(hint);
        root.appendChild(box);
      };
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
