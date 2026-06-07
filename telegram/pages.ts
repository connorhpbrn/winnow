// Small branded HTML pages shown in the browser after the OAuth redirect. Real browser
// context (not a Telegram attachment), so fonts load fine from Google Fonts. Matches the
// edition: dark canvas, Instrument Serif wordmark, Geist body, amber accent.
export function statusPage(opts: { title: string; subtitle: string; tone?: 'ok' | 'error' }): string {
  const accent = opts.tone === 'error' ? '#f87171' : '#f5a524';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Winnow</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Instrument+Serif&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#0e0e0d; --fg:#e7e7e2; --muted:#9c9c95; --accent:${accent}; }
  * { margin:0; box-sizing:border-box; }
  html, body { height:100%; }
  body {
    background:var(--bg); color:var(--fg);
    font-family:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px;
  }
  .card { text-align:center; max-width:440px; }
  .mark { display:inline-block; font-family:"Instrument Serif", Georgia, serif; font-weight:400; font-size:60px; line-height:1; letter-spacing:0; border-bottom:3px solid var(--accent); padding-bottom:14px; margin-bottom:30px; }
  .title { font-size:25px; font-weight:600; letter-spacing:-0.01em; margin-bottom:12px; }
  .sub { font-size:16px; font-weight:400; line-height:1.55; color:var(--muted); }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">Winnow</div>
    <div class="title">${escapeHtml(opts.title)}</div>
    <div class="sub">${escapeHtml(opts.subtitle)}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
