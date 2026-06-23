/** Tiny shared helpers for the OAuth HTML/redirect routes. */

/** Public-facing base origin, respecting Vercel/proxy forwarding headers. */
export function baseOrigin(req: Request): string {
  const h = req.headers;
  const proto = h.get('x-forwarded-proto') || 'https';
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  return `${proto}://${host}`;
}

/** The TikTok redirect URI: explicit env override, else derived from the request. */
export function tiktokRedirectUri(req: Request): string {
  const explicit = process.env.TIKTOK_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  return `${baseOrigin(req)}/api/tiktok/callback`;
}

/** Read a single cookie value from the request. */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Minimal HTML escaping for safely echoing values into a page. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap body fragments in a styled HTML document. */
export function htmlPage(title: string, body: string, status = 200): Response {
  const doc = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         background:#0b0b0f; color:#e8e8ed; margin:0; }
  main { max-width:760px; margin:0 auto; padding:48px 24px; }
  h1 { font-size:24px; } h2 { font-size:17px; margin-top:28px; }
  code, .v { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .field { background:#1b1b24; border:1px solid #2a2a36; border-radius:8px;
           padding:12px 14px; margin:10px 0; word-break:break-all; }
  .label { color:#9a9aa6; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .v { font-size:14px; display:block; margin-top:4px; }
  .ok { color:#37d399; } .err { color:#ff6b6b; }
  a { color:#7aa2ff; }
  ol { line-height:1.8; } .muted { color:#9a9aa6; }
</style></head><body><main>${body}</main></body></html>`;
  return new Response(doc, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
