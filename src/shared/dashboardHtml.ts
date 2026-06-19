/**
 * Self-contained read-only web dashboard served at GET /dashboard by both the
 * extension's MCP server and the CLI's headless server. No external resources
 * (works offline, no CDN); polls the token-gated /api endpoints every 2s.
 * Pure string builder — no `vscode` imports.
 */
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>GridFlow — Workflows</title>
<style>
  :root {
    --bg: #1e1e1e; --panel: #252526; --border: #3c3c3c; --fg: #d4d4d4;
    --muted: #8a8a8a; --accent: #3794ff; --green: #89d185; --red: #f48771;
    --yellow: #cca700; --orange: #d18616;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 24px;
           border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  main { padding: 16px 24px; max-width: 1100px; margin: 0 auto; }
  .empty { color: var(--muted); padding: 48px 0; text-align: center; }
  .wf { background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
        margin-bottom: 12px; overflow: hidden; }
  .wf-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer; }
  .wf-head:hover { background: #2a2d2e; }
  .wf-title { font-weight: 600; }
  .wf-stats { color: var(--muted); font-size: 12px; margin-left: auto; white-space: nowrap; }
  .bar { height: 4px; background: #333; }
  .bar-fill { height: 100%; background: var(--green); transition: width .3s; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 12px; border-top: 1px solid var(--border);
           vertical-align: top; }
  th { color: var(--muted); font-weight: 500; border-top: none; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .s-pending,.s-cancelled { background: var(--muted); }
  .s-queued { background: var(--accent); }
  .s-running { background: var(--yellow); animation: pulse 1.2s infinite; }
  .s-blocked { background: var(--orange); }
  .s-done { background: var(--green); }
  .s-failed { background: var(--red); }
  @keyframes pulse { 50% { opacity: .35; } }
  .out { color: var(--muted); max-width: 420px; overflow: hidden; text-overflow: ellipsis;
         display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  .err { color: var(--red); padding: 24px; text-align: center; }
  .updated { color: var(--muted); font-size: 11px; margin-left: 8px; }
</style>
</head>
<body>
<header><h1>GridFlow</h1><span class="sub">live workflow dashboard</span><span class="updated" id="updated"></span></header>
<main id="main"><div class="empty">Loading…</div></main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var expanded = {};
  var details = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path) {
    return fetch(path + (path.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(token))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function fmtCost(v) { return v ? '$' + v.toFixed(4) : '—'; }
  function fmtDur(ms) {
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function rowTable(detail) {
    var cols = detail.columns.map(function (c) { return c.name; });
    var head = '<tr><th></th><th>' + cols.map(esc).join('</th><th>') +
      '</th><th>Agent</th><th>Duration</th><th>Cost (est.)</th><th>Output</th></tr>';
    var body = detail.rows.map(function (r) {
      var cells = cols.map(function (c) { return '<td>' + esc(r.cells[c]) + '</td>'; }).join('');
      return '<tr><td><span class="dot s-' + esc(r.status) + '"></span>' + esc(r.status) + '</td>' +
        cells + '<td>' + esc(r.assignedAgent || '—') + '</td><td>' + fmtDur(r.durationMs) +
        '</td><td>' + fmtCost(r.costUsd) + '</td><td><div class="out">' + esc(r.outputs || '') + '</div></td></tr>';
    }).join('');
    return '<table>' + head + body + '</table>';
  }

  function render(list) {
    var main = document.getElementById('main');
    if (!list.length) { main.innerHTML = '<div class="empty">No workflows yet. Open one in VS Code or via the MCP tools.</div>'; return; }
    main.innerHTML = list.map(function (wf) {
      var st = wf.stats || {};
      var pct = st.total ? Math.round(100 * (st.done || 0) / st.total) : 0;
      var det = expanded[wf.slug] && details[wf.slug] ? rowTable(details[wf.slug]) : '';
      return '<div class="wf"><div class="wf-head" data-slug="' + esc(wf.slug) + '">' +
        '<span class="wf-title">' + esc(wf.title || wf.slug) + '</span>' +
        '<span class="wf-stats">' + (st.done || 0) + '/' + (st.total || 0) + ' done' +
        (st.running ? ' · ' + st.running + ' running' : '') +
        (st.failed ? ' · ' + st.failed + ' failed' : '') +
        ' · ' + fmtCost(st.totalCostUsd || 0) + ' · ' + fmtDur(st.totalDurationMs || 0) +
        '</span></div><div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        det + '</div>';
    }).join('');
    Array.prototype.forEach.call(main.querySelectorAll('.wf-head'), function (el) {
      el.addEventListener('click', function () {
        var slug = el.getAttribute('data-slug');
        expanded[slug] = !expanded[slug];
        tick();
      });
    });
  }

  function tick() {
    api('/api/workflows').then(function (list) {
      var wanted = list.filter(function (wf) { return expanded[wf.slug]; });
      return Promise.all(wanted.map(function (wf) {
        return api('/api/workflows/' + encodeURIComponent(wf.slug)).then(function (d) { details[wf.slug] = d; });
      })).then(function () {
        render(list);
        document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
      });
    }).catch(function (e) {
      document.getElementById('main').innerHTML = '<div class="err">Cannot reach GridFlow (' + esc(e.message) +
        '). Is VS Code (or \\u0060gridflow serve\\u0060) running, and is the token in the URL valid?</div>';
    });
  }

  tick();
  setInterval(tick, 2000);
})();
</script>
</body>
</html>`;
}
