import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { store } from './store';
import { onHostMessage, post } from './vscode';

import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  document.body.innerHTML = '<div style="padding:20px;color:#f48771">GridFlow: #root element not found in webview HTML.</div>';
  throw new Error('GridFlow: #root element missing');
}

// Mount React before sending 'ready' so that any synchronous errors during module
// evaluation show up via the error boundary rather than as an invisible failure.
try {
  const root = createRoot(rootEl);
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (err) {
  // Build via textContent — never innerHTML — so the error stack can't inject markup.
  rootEl.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('style', 'padding:20px;font-family:monospace;color:#f48771');
  const title = document.createElement('b');
  title.textContent = 'GridFlow mount error';
  const detail = document.createElement('pre');
  detail.textContent = err instanceof Error ? err.stack ?? err.message : String(err);
  box.appendChild(title);
  box.appendChild(detail);
  rootEl.appendChild(box);
  throw err;
}

// Bridge: receive messages from the extension host and apply them to the store.
onHostMessage((msg) => {
  switch (msg.type) {
    case 'init':
      store.init(msg.snapshot, msg.mode, msg.canSendToChat);
      // Eagerly fetch templates so the Templates menu is responsive.
      post({ type: 'requestTemplates' });
      return;
    case 'setSnapshot':
      store.setSnapshot(msg.snapshot, false);
      return;
    case 'templates':
      store.setTemplates(msg.templates);
      return;
    case 'csvParsed':
      store.replaceFromCsv(msg.columns, msg.rows);
      return;
    case 'pendingChatInvocation':
      store.setPendingChat(msg.pending);
      return;
    case 'hashCompletions':
      window.dispatchEvent(new CustomEvent('gridflow:hash-completions', { detail: msg }));
      return;
    case 'filePickerResult':
      window.dispatchEvent(new CustomEvent('gridflow:file-picker-result', { detail: msg }));
      return;
    case 'themeChanged':
      // CSS variables auto-update — nothing to do.
      return;
  }
});

// Tell the host we're ready to receive the initial state.
post({ type: 'ready' });
