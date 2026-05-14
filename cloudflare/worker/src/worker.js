/**
 * tekdruid.com router — Cloudflare Worker (hardened).
 *
 * Security posture
 * ────────────────
 * 1. Method gate      — only GET / HEAD / OPTIONS pass to Pages (static site).
 * 2. Host validation  — rejects requests with unexpected Host values.
 * 3. Path sanitise    — rejects traversal sequences (%2e, ..) before forwarding.
 * 4. Bot / scanner    — blocks well-known scanner & exploit UA strings.
 * 5. Telemetry strip  — removes NEL, Report-To, Server headers Cloudflare adds.
 * 6. CORS lock        — replaces Pages' default ACAO: * with the canonical origin.
 * 7. Preflight        — handles OPTIONS with minimal CORS (no credentials, no wildcard).
 * 8. Path prefix      — strips /privacyscript before forwarding to privacyscript.pages.dev.
 * 9. Redirect rewrite — rewrites Pages Location headers back through the public prefix.
 */

const PAGES_ORIGIN  = 'https://privacyscript.pages.dev';
const PUBLIC_ORIGIN = 'https://tekdruid.com';
const PREFIX        = '/privacyscript';

/** HTTP methods that make sense on a fully static Next.js export. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Known scanner / exploit / headless-automation user-agent substrings (lower-case).
 * Keeping the list conservative to avoid false positives on legitimate CLI tools.
 */
const BLOCKED_UA_FRAGMENTS = [
  'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab', 'nessus', 'openvas',
  'burpsuite', 'dirbuster', 'gobuster', 'feroxbuster', 'nuclei', 'acunetix',
  'wapiti', 'appscan', 'w3af', 'skipfish', 'arachni', 'vega/1',
  'metasploit', 'netsparker', 'qualys', 'rapid7',
];

/** Response headers that leak infrastructure details or send error telemetry. */
const STRIP_RESPONSE_HEADERS = ['nel', 'report-to', 'server', 'x-powered-by', 'via'];

export default {
  /**
   * @param {Request}     request
   * @param {unknown}     _env
   * @param {ExecutionContext} _ctx
   */
  async fetch(request, _env, _ctx) {
    const url = new URL(request.url);

    // ── 1. Host validation ──────────────────────────────────────────────────
    // The route binding already constrains which requests reach us, but an
    // explicit check defends against Host-header injection edge cases.
    if (url.hostname !== 'tekdruid.com') {
      return text(403, 'Forbidden');
    }

    // ── Non-privacyscript paths pass straight through (should not happen in
    //    practice because the route binding is precise, but included for safety).
    if (!url.pathname.startsWith(PREFIX)) {
      return fetch(request);
    }

    // ── 2. Method gate ───────────────────────────────────────────────────────
    if (!ALLOWED_METHODS.has(request.method)) {
      return text(405, 'Method Not Allowed', { Allow: 'GET, HEAD, OPTIONS' });
    }

    // ── 3. Path traversal guard ──────────────────────────────────────────────
    const raw = url.pathname + url.search;
    if (raw.includes('..') || /%2e%2e/i.test(raw) || /%252e/i.test(raw)) {
      return text(400, 'Bad Request');
    }

    // ── 4. Bot / scanner filter ──────────────────────────────────────────────
    const ua = (request.headers.get('User-Agent') ?? '').toLowerCase();
    if (BLOCKED_UA_FRAGMENTS.some(frag => ua.includes(frag))) {
      return text(403, 'Forbidden');
    }

    // ── 5. OPTIONS preflight — return minimal CORS, no wildcard ─────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin':  PUBLIC_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, HEAD',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age':       '86400',
          'Vary':                         'Origin',
        },
      });
    }

    // ── 6. Build upstream URL (strip /privacyscript prefix) ──────────────────
    let stripped = url.pathname.slice(PREFIX.length);
    if (stripped === '') stripped = '/';
    const upstreamUrl = new URL(stripped + url.search, PAGES_ORIGIN);

    // Forward with same method / body. Use 'manual' redirect so we can rewrite
    // Location headers ourselves.
    const upstreamReq = new Request(upstreamUrl.toString(), {
      method:   request.method,
      headers:  request.headers,
      body:     request.body,
      redirect: 'manual',
    });

    const resp = await fetch(upstreamReq);

    // ── 7. Build clean response headers ─────────────────────────────────────
    const out = new Headers(resp.headers);

    // Remove telemetry and infrastructure-disclosure headers.
    for (const h of STRIP_RESPONSE_HEADERS) {
      out.delete(h);
    }

    // Replace Pages' default ACAO: * with the canonical public origin.
    // This prevents any third-party site from cross-origin-reading our responses.
    out.set('Access-Control-Allow-Origin', PUBLIC_ORIGIN);
    out.set('Vary', 'Origin');

    // ── 8. Redirect Location rewrite ─────────────────────────────────────────
    if (resp.status >= 300 && resp.status < 400) {
      const loc = out.get('Location');
      if (loc) {
        try {
          const parsed = new URL(loc, upstreamUrl);
          if (parsed.origin === PAGES_ORIGIN) {
            out.set('Location', `${PREFIX}${parsed.pathname}${parsed.search}`);
          }
        } catch {
          // Non-URL Location value — leave it untouched.
        }
      }
    }

    // ── 9. HTML transforms: nonce injection + beacon removal ─────────────────
    //
    // Next.js App Router emits inline <script> tags to deliver RSC hydration
    // data (self.__next_f.push(…)).  Our strict script-src blocks ALL inline
    // scripts by default, which prevents React from hydrating — making every
    // button unclickable.
    //
    // Fix: generate a cryptographically random nonce per request, add it to
    // every inline script tag, and add 'nonce-{nonce}' to the script-src
    // directive in the CSP header.  External scripts (those with src=) are
    // still covered by 'self'; the nonce only extends to inline scripts.
    //
    // We also remove any Cloudflare analytics beacon injected at zone level
    // (belt-and-braces — our updated CSP already blocks it via nonce mismatch,
    // but removing the tag prevents browser console violations).
    const ct = out.get('Content-Type') ?? '';
    if (ct.includes('text/html')) {
      const body = await resp.text();

      // Generate a secure 128-bit nonce for this response.
      const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
      const nonce = btoa(String.fromCharCode(...nonceBytes));

      const transformed = body
        // Remove Cloudflare analytics beacon (self-closing variant)
        .replace(/<script\b[^>]*cloudflareinsights[^>]*\/>/gi, '')
        // Remove Cloudflare analytics beacon (paired variant)
        .replace(/<script\b[^>]*cloudflareinsights[^>]*>[\s\S]*?<\/script>/gi, '')
        // Inject nonce into every INLINE script tag (those without src=).
        // Captures all existing attributes so they are preserved.
        .replace(
          /<script\b((?![^>]*\bsrc=)[^>]*)>/gi,
          (_, attrs) => `<script${attrs} nonce="${nonce}">`
        );

      // Update the Content-Security-Policy header to permit the nonce.
      // The directive already contains  script-src 'self' 'wasm-unsafe-eval';
      // we insert the nonce alongside those.
      const csp = out.get('Content-Security-Policy') ?? '';
      out.set(
        'Content-Security-Policy',
        csp.replace(/\bscript-src\b/, `script-src 'nonce-${nonce}'`)
      );

      return new Response(transformed, {
        status:     resp.status,
        statusText: resp.statusText,
        headers:    out,
      });
    }

    return new Response(resp.body, {
      status:     resp.status,
      statusText: resp.statusText,
      headers:    out,
    });
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function text(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    },
  });
}
