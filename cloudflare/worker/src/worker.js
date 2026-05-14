/**
 * tekdruid.com router — Cloudflare Worker.
 *
 * The TekDruid marketing site is hosted on Bluehost at tekdruid.com. PrivacyScript
 * is hosted on Cloudflare Pages at privacyscript.pages.dev. We want a single
 * origin for SEO, so this worker — bound to `tekdruid.com/privacyscript*` —
 * proxies those requests to Pages and returns Pages's response verbatim.
 *
 * Everything else on tekdruid.com bypasses the worker and hits Bluehost as
 * normal.
 *
 * Path mapping:
 *   tekdruid.com/privacyscript        → privacyscript.pages.dev/
 *   tekdruid.com/privacyscript/       → privacyscript.pages.dev/
 *   tekdruid.com/privacyscript/foo    → privacyscript.pages.dev/foo
 *   tekdruid.com/privacyscript/_next/X → privacyscript.pages.dev/_next/X
 *
 * The static export embeds asset URLs as `/privacyscript/_next/...` because
 * Next.js was built with basePath=/privacyscript. The browser hits this worker
 * for every embedded URL, the worker strips, Pages serves.
 */

const PAGES_ORIGIN = 'https://privacyscript.pages.dev';
const PREFIX = '/privacyscript';

export default {
  /**
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(PREFIX)) {
      // Should not happen given the route binding, but pass through to be safe.
      return fetch(request);
    }

    // Strip /privacyscript. Empty result means root.
    let stripped = url.pathname.slice(PREFIX.length);
    if (stripped === '') stripped = '/';

    const upstreamUrl = new URL(stripped + url.search, PAGES_ORIGIN);

    // Forward original method + headers + body. Strip cf-* hop-by-hop headers
    // that would confuse Pages.
    const upstreamReq = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });

    const resp = await fetch(upstreamReq);

    // Pass through, but rewrite Location headers so a Pages redirect to /foo
    // becomes /privacyscript/foo on the public URL.
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('Location');
      if (loc) {
        try {
          const parsed = new URL(loc, upstreamUrl);
          if (parsed.origin === PAGES_ORIGIN) {
            const newPath = `${PREFIX}${parsed.pathname}${parsed.search}`;
            const newHeaders = new Headers(resp.headers);
            newHeaders.set('Location', newPath);
            return new Response(resp.body, {
              status: resp.status,
              statusText: resp.statusText,
              headers: newHeaders,
            });
          }
        } catch {
          // Non-URL Location → leave alone.
        }
      }
    }

    return resp;
  },
};
