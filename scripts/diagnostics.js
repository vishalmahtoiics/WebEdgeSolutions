// A standing-in server for when the app cannot start.
//
// On a container platform an exiting process becomes a restart loop, and the
// proxy in front of it answers "404 page not found" because nothing is
// listening. The reason only exists in container logs, which are often the
// hardest thing to reach.
//
// So instead of exiting, bind the port and answer every request with the
// problem and its fix. The operator sees the cause in the browser, and the
// proxy has a healthy backend to route to.

import http from 'node:http';

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

function page(problems) {
  const items = problems
    .map(
      (p) => `
      <li class="item">
        <h2>${escape(p.title)}</h2>
        ${p.detail ? `<p>${escape(p.detail)}</p>` : ''}
        ${p.fix ? `<div class="fix"><span class="fix-label">Fix</span><pre>${escape(p.fix)}</pre></div>` : ''}
      </li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup needed — Hosting Portal</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f4f6f9; color:#1b2333;
    font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.55; }
  header { background:#17203a; color:#fff; padding:22px 20px; }
  .wrap { max-width:760px; margin:0 auto; }
  header h1 { margin:0; font-size:19px; font-weight:600; }
  header p { margin:6px 0 0; color:#9aa5c4; font-size:14px; }
  main { padding:26px 20px 60px; }
  ul { list-style:none; margin:0; padding:0; }
  .item { background:#fff; border:1px solid #e4e8ef; border-radius:12px;
    padding:20px; margin-bottom:16px; box-shadow:0 1px 3px rgba(16,24,40,.06); }
  .item h2 { margin:0 0 8px; font-size:16px; color:#c02626; }
  .item p { margin:0; color:#475467; font-size:14.5px; }
  .fix { margin-top:14px; }
  .fix-label { display:inline-block; font-size:11px; font-weight:600; letter-spacing:.07em;
    text-transform:uppercase; color:#0f7b56; background:#e6f6ef;
    padding:3px 9px; border-radius:999px; margin-bottom:8px; }
  pre { margin:0; background:#f7f8fb; border:1px solid #e4e8ef; border-radius:8px;
    padding:12px 14px; overflow-x:auto; font-size:13.5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; }
  .note { color:#667085; font-size:13.5px; margin-top:22px; }
</style></head>
<body>
  <header><div class="wrap">
    <h1>Setup needed</h1>
    <p>The portal is running but cannot start until this is resolved.</p>
  </div></header>
  <main><div class="wrap">
    <ul>${items}</ul>
    <p class="note">Update the environment variables, then <strong>Redeploy</strong>
    (not Restart) so the new values reach the container. This page disappears once
    the problem is fixed.</p>
  </div></main>
</body></html>`;
}

/// Binds the app's port and serves `problems` on every request. Returns the
/// server so a caller that recovers can close it and boot normally.
export function serveDiagnostics(problems) {
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer((req, res) => {
    // Keep the health endpoint honest: this instance is not serving the app.
    if (req.url === '/api/health') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Configuration incomplete.' }));
    }
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page(problems));
  });

  server.on('error', (err) => {
    console.error(`  Could not bind port ${port} for the setup page: ${err.message}`);
  });

  server.listen(port, () => {
    console.error(`\n  → Serving the setup page on port ${port} until this is fixed.\n`);
  });

  return server;
}
