// Console Phase 2 — reverse-proxy embed of admin UIs behind the initData lock.
//
// Goal: from the Console Mini App, tap a service and drill straight INTO its full
// UI, already authenticated — no second login, all still under the single-owner
// initData gate and reachable ONLY under /console* on the public tunnel.
//
// PoC target: Dagu. Dagu uses HTTP basic auth, so "already logged in" reduces to
// injecting one server-side header: Authorization: Basic base64(user:pass). The
// creds (DAGU_AUTH_BASIC_*) live in env and NEVER reach the client.
//
// Crux solved by config, not code: Dagu supports a native base path. We set
// DAGU_BASE_PATH=/console/svc/dagu on the Dagu service, so Dagu bakes that prefix
// into its SPA (apiURL: "/console/svc/dagu/api/v1", assets under the prefix, etc).
// That means this proxy is a DUMB pass-through with ZERO URL rewriting — the
// single biggest fragility killer for sub-path embeds. We forward
//   /console/svc/dagu/*  ->  http://127.0.0.1:8080/console/svc/dagu/*  (verbatim)
// adding only the auth header.
//
// Live updates: Dagu streams status/logs over SSE (text/event-stream), not
// websockets. http-proxy-middleware passes long-lived responses through; we keep
// ws:true defensively. We must NOT buffer the response (SSE would never flush).
//
// SECURITY: the proxy mounts behind requireOwner, so a tunnel request without
// valid owner initData is 401'd by Console's own gate BEFORE it reaches the
// upstream — the Dagu UI is never served to an unauthenticated public hit. The
// publicGuard already confines tunnel traffic to /console*; this path qualifies.
import { createProxyMiddleware, fixRequestBody, type Options } from 'http-proxy-middleware';
import type { RequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';

// The public-facing prefix the Mini App navigates to AND the base path Dagu is
// configured with (DAGU_BASE_PATH). They are identical on purpose so no rewrite
// is needed. Keep in sync with the Dagu service's DAGU_BASE_PATH.
export const DAGU_CONSOLE_PREFIX = '/console/svc/dagu';

const DAGU_TARGET = process.env.DAGU_HOST_LOCAL ?? 'http://127.0.0.1:8080';
const DAGU_USER = process.env.DAGU_AUTH_BASIC_USERNAME ?? '';
const DAGU_PASS = process.env.DAGU_AUTH_BASIC_PASSWORD ?? '';

export const daguProxyConfigured = (): boolean => Boolean(DAGU_USER && DAGU_PASS);

function daguAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${DAGU_USER}:${DAGU_PASS}`).toString('base64');
}

// --- Telegram safe-area injection for the proxied Dagu HTML -----------------
// Dagu's SPA is not Telegram-aware. We fix two things WITHOUT touching Dagu by
// injecting, before </head>, a snippet that:
//
//  SAFE AREA (fullscreen): Dagu's sticky top bar (`sticky top-0 z-10`) renders
//  flush to the viewport top, sliding UNDER the device status bar and Telegram's
//  Close/⋯ controls. We compute inset = safeAreaInset.top + contentSafeAreaInset.top,
//  expose it as --dagu-tg-safe-top, pad the page top by it, AND push any
//  sticky/fixed top-0 bar DOWN by the inset (body padding alone doesn't help a
//  sticky element once scrolled). Re-applied on safeAreaChanged /
//  contentSafeAreaChanged / fullscreenChanged.
//
//  THEME: Dagu (2.7.3) selects dark/light via localStorage["colorMode"]
//  ("light"|"dark"|"system") and toggles `.dark` on <html> (Tailwind dark mode).
//  We mirror Telegram's colorScheme: set localStorage + the .dark class in the
//  HEAD script BEFORE Dagu hydrates (so first paint matches), and re-apply on
//  themeChanged. Net: proxied Dagu follows the Telegram dark/light theme.
//
// The first <script> (theme) must run synchronously in <head> before the deferred
// Dagu bundle, so the .dark class + colorMode are set before React reads them.
// Idempotent and a no-op outside Telegram (insets 0, colorScheme absent).
const DAGU_SAFEAREA_SNIPPET = `<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function(){
  // Runs in <head> before Dagu's deferred bundle: pre-seed theme for first paint.
  try {
    var w = window.Telegram && window.Telegram.WebApp;
    var scheme = w && w.colorScheme === 'dark' ? 'dark' : (w && w.colorScheme === 'light' ? 'light' : null);
    if (scheme) {
      try { localStorage.setItem('colorMode', scheme); } catch(e){}
      document.documentElement.classList.toggle('dark', scheme === 'dark');
    }
  } catch(e){}
})();
</script>
<style id="dagu-tg-safe-style">
  :root { --dagu-tg-safe-top: 0px; }
  body { padding-top: var(--dagu-tg-safe-top) !important; box-sizing: border-box; }
  /* Dagu's sticky header is "sticky top-0"; re-anchor it below the TG chrome. */
  .sticky.top-0 { top: var(--dagu-tg-safe-top) !important; }
  [style*="position: fixed"][style*="top: 0"],
  .fixed.top-0 { top: var(--dagu-tg-safe-top) !important; }
</style>
<script>
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  function applyInset(){
    var top = 0;
    try {
      if (tg) {
        var sa = tg.safeAreaInset || {}, csa = tg.contentSafeAreaInset || {};
        top = (sa.top || 0) + (csa.top || 0);
      }
    } catch (e) {}
    document.documentElement.style.setProperty('--dagu-tg-safe-top', top + 'px');
  }
  function applyTheme(){
    try {
      if (!tg || !tg.colorScheme) return;
      var scheme = tg.colorScheme === 'dark' ? 'dark' : 'light';
      try { localStorage.setItem('colorMode', scheme); } catch(e){}
      document.documentElement.classList.toggle('dark', scheme === 'dark');
    } catch (e) {}
  }
  function boot(){
    if (window.__daguTgSafe) return; window.__daguTgSafe = true;
    try { if (tg && tg.ready) tg.ready(); } catch(e){}
    applyInset(); applyTheme();
    if (tg && tg.onEvent) {
      tg.onEvent('safeAreaChanged', applyInset);
      tg.onEvent('contentSafeAreaChanged', applyInset);
      tg.onEvent('fullscreenChanged', applyInset);
      tg.onEvent('themeChanged', applyTheme);
    }
    // Dagu paints its header/theme after React mounts; re-apply a few times so
    // the top override and .dark class land on the freshly-rendered DOM (React
    // may overwrite the class on its first effect — we re-assert it).
    var n = 0, iv = setInterval(function(){ applyInset(); applyTheme(); if (++n > 10) clearInterval(iv); }, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>`;

// Decompress an upstream body for inspection/rewrite. Dagu's HTML shell is small
// and may arrive gzip/br/deflate-encoded; we decode, inject, and re-send
// uncompressed (Content-Encoding stripped, Content-Length recomputed).
function decodeBody(buf: Buffer, encoding?: string): Buffer {
  try {
    switch ((encoding ?? '').toLowerCase()) {
      case 'gzip': return gunzipSync(buf);
      case 'br': return brotliDecompressSync(buf);
      case 'deflate': return inflateSync(buf);
      default: return buf;
    }
  } catch {
    return buf; // if decode fails, fall back to raw (injection just won't match)
  }
}

/**
 * Build the Dagu reverse-proxy middleware. It is mounted via
 * `app.use(DAGU_CONSOLE_PREFIX, requireSvcCookie, createDaguProxy())`, so Express
 * strips DAGU_CONSOLE_PREFIX from req.url before the proxy runs (proxy sees "/",
 * "/api/v1/dags", "/assets/bundle.js", …). Dagu is configured with the SAME base
 * path (DAGU_BASE_PATH) and expects the full prefix upstream, so `pathRewrite`
 * re-prepends it. Net effect = verbatim forwarding with no content rewriting.
 */
export function createDaguProxy(): RequestHandler {
  const options: Options = {
    target: DAGU_TARGET,
    changeOrigin: true,
    ws: true, // defensive; Dagu uses SSE, but harmless to allow upgrades
    // We self-handle responses so we can inject the Telegram safe-area + theme
    // snippet into Dagu's HTML shell. CRITICAL: only the text/html document is
    // buffered+rewritten; every other response (assets, JSON API, and especially
    // SSE text/event-stream live-updates) is piped straight through unbuffered,
    // so streaming still flushes as it arrives.
    selfHandleResponse: true,
    // We mount with app.use(PREFIX, ...), so Express strips the prefix from
    // req.url before the proxy sees it. Dagu is configured with the SAME base
    // path and expects the full prefix upstream, so we re-prepend it. Net effect
    // is verbatim forwarding (/console/svc/dagu/x -> /console/svc/dagu/x) with no
    // rewriting of any content — only restoring what Express stripped.
    pathRewrite: (path: string) => {
      // `path` here is the post-mount, prefix-stripped path. Express leaves the
      // ROOT of the mount as "" (for /console/svc/dagu) or "/" (for the trailing
      // -slash form). Dagu serves its SPA at the NO-slash base path
      // (/console/svc/dagu -> 200) and 301-redirects the trailing-slash form to
      // it. So map BOTH root forms to the no-slash base path to avoid a redirect
      // loop; forward any deeper path verbatim under the prefix.
      const [pathname, ...qs] = path.split('?');
      const query = qs.length ? '?' + qs.join('?') : '';
      if (pathname === '' || pathname === '/') {
        return `${DAGU_CONSOLE_PREFIX}${query}`;
      }
      const tail = pathname.startsWith('/') ? pathname : `/${pathname}`;
      return `${DAGU_CONSOLE_PREFIX}${tail}${query}`;
    },
    on: {
      proxyReq: (proxyReq, req, res) => {
        // Inject server-side basic auth — the "already logged in" trick. The
        // client never sees these creds.
        proxyReq.setHeader('authorization', daguAuthHeader());
        // We self-handle the response, so ask upstream for an UNcompressed body
        // when it's the HTML shell we want to rewrite. Simplest robust path:
        // signal we accept identity (Dagu may still gzip; decodeBody handles it).
        proxyReq.setHeader('accept-encoding', 'identity');
        // express.json() may have already consumed the body for POSTs
        // (start/stop/retry). Re-stream it so the upstream receives it intact.
        fixRequestBody(proxyReq, req as never);
      },
      // selfHandleResponse=true means WE must end the client response. Stream
      // everything verbatim, except inject our snippet into the HTML document.
      proxyRes: (proxyRes: IncomingMessage, _req, res) => {
        const clientRes = res as ServerResponse;
        const status = proxyRes.statusCode ?? 502;
        const ctype = String(proxyRes.headers['content-type'] ?? '');
        const isHtml = ctype.includes('text/html');

        if (!isHtml) {
          // Pass-through (assets, JSON, SSE): copy status + headers, then pipe
          // unbuffered so streaming responses flush as they arrive.
          clientRes.writeHead(status, proxyRes.headers as Record<string, string | string[]>);
          proxyRes.pipe(clientRes);
          return;
        }

        // HTML document → buffer, inject the Telegram snippet before </head>,
        // recompute length, send. (Dagu's shell is a few KB.)
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks);
          const decoded = decodeBody(raw, proxyRes.headers['content-encoding'] as string | undefined);
          let html = decoded.toString('utf8');
          if (html.includes('</head>')) {
            html = html.replace('</head>', `${DAGU_SAFEAREA_SNIPPET}\n</head>`);
          } else {
            // No </head> (shouldn't happen for Dagu) — prepend so it still runs.
            html = DAGU_SAFEAREA_SNIPPET + html;
          }
          const body = Buffer.from(html, 'utf8');
          const headers = { ...proxyRes.headers } as Record<string, string | string[]>;
          // We decoded the body and changed its length; drop stale encoding/length.
          delete headers['content-encoding'];
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          headers['content-length'] = String(body.length);
          clientRes.writeHead(status, headers);
          clientRes.end(body);
        });
        proxyRes.on('error', () => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          clientRes.end();
        });
      },
      error: (err, _req, res) => {
        // res can be a ServerResponse (HTTP) or a Socket (ws). Guard for HTTP.
        const r = res as { writeHead?: (c: number, h?: Record<string, string>) => void; end?: (b?: string) => void };
        try {
          if (typeof r.writeHead === 'function' && typeof r.end === 'function') {
            r.writeHead(502, { 'Content-Type': 'application/json' });
            r.end(JSON.stringify({ error: 'dagu_proxy_failed', detail: err.message }));
          }
        } catch {
          /* socket already torn down */
        }
      },
    },
  };
  return createProxyMiddleware(options) as unknown as RequestHandler;
}
