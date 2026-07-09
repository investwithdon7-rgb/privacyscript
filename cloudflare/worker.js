/**
 * PrivacyScript edge worker.
 *
 * Serves the static export (out/, uploaded as Workers Static Assets) at
 * tekdruid.com/privacyscript*. The export is built with
 * basePath=/privacyscript, so every URL the app emits carries the prefix,
 * while the files themselves live unprefixed in the asset store — this
 * worker strips the prefix before asset lookup.
 *
 * No request bodies are read, nothing is logged, nothing is forwarded to any
 * other origin: the worker only rewrites the path and hands the request to
 * the same-origin asset store (zero-telemetry guarantee holds at the edge).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Canonicalise /privacyscript → /privacyscript/
    if (url.pathname === '/privacyscript') {
      url.pathname = '/privacyscript/';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith('/privacyscript/')) {
      url.pathname = url.pathname.slice('/privacyscript'.length);
    } else if (url.pathname === '/') {
      // workers.dev preview hits the root — bounce into the app.
      url.pathname = '/privacyscript/';
      return Response.redirect(url.toString(), 301);
    }

    return env.ASSETS.fetch(new Request(url.toString(), request));
  },
};
