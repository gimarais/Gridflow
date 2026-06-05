/**
 * The GridFlow stdio↔HTTP MCP proxy script, embedded as a string so the extension
 * can write it to ~/.gridflow/proxy.js at activation time.
 *
 * The Claude desktop app (and other stdio-only MCP hosts) spawn this as a child
 * process. It bridges their stdio JSON-RPC stream to the HTTP/SSE server that the
 * GridFlow VS Code extension runs on localhost.
 */
export const PROXY_SCRIPT = `#!/usr/bin/env node
'use strict';
// GridFlow MCP stdio proxy — written by the GridFlow VS Code extension.
// The GridFlow extension must be running in VS Code for this proxy to connect.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const portFile = path.join(os.homedir(), '.gridflow', 'current-port');
const port = (() => {
  try { return parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) || 54321; }
  catch { return 54321; }
})();

const tokenFile = path.join(os.homedir(), '.gridflow', 'token');
const token = (() => {
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch { return ''; }
})();

process.stderr.write('GridFlow proxy: connecting to port ' + port + '\\n');

let sessionId = null;
let sseBuffer = '';
let currentEvent = '';
let stdinReady = false;

function pipeStdin() {
  if (stdinReady) return;
  stdinReady = true;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const body = line.trim();
    if (!body || !sessionId) return;
    const buf = Buffer.from(body, 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1', port,
        path: '/message?sessionId=' + sessionId,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': buf.length, 'x-gridflow-token': token },
      },
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.write(buf);
    req.end();
  });
  rl.on('close', () => process.exit(0));
}

const sseReq = http.get(
  {
    hostname: '127.0.0.1', port, path: '/sse',
    headers: { 'x-gridflow-token': token },
  },
  (res) => {
  if (res.statusCode !== 200) {
    process.stderr.write('GridFlow: HTTP ' + res.statusCode + '. Open VS Code with the GridFlow extension running, then reload the window to refresh the token.\\n');
    process.exit(1);
  }
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    sseBuffer += chunk;
    const lines = sseBuffer.split('\\n');
    sseBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (!data) continue;
        if (currentEvent === 'endpoint') {
          const m = data.match(/sessionId=([^&\\s]+)/);
          if (m) {
            sessionId = m[1];
            process.stderr.write('GridFlow proxy: connected (session ' + sessionId + ')\\n');
            pipeStdin();
          }
        } else if (currentEvent === 'message') {
          process.stdout.write(data + '\\n');
        }
      } else if (line === '') {
        currentEvent = '';
      }
    }
  });
  res.on('end', () => { process.stderr.write('GridFlow: SSE stream closed.\\n'); process.exit(0); });
  res.on('error', (e) => { process.stderr.write('GridFlow SSE: ' + e.message + '\\n'); process.exit(1); });
});

sseReq.on('error', (e) => {
  process.stderr.write(
    'GridFlow proxy: cannot connect to port ' + port + ': ' + e.message + '\\n' +
    'Make sure VS Code is open with the GridFlow extension running.\\n'
  );
  process.exit(1);
});

setTimeout(() => {
  if (!sessionId) {
    process.stderr.write('GridFlow proxy: timed out waiting for connection.\\n');
    process.exit(1);
  }
}, 10000);
`;
