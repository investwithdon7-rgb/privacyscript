/**
 * Resolve a path to a static asset under the current basePath.
 *
 * Because PrivacyScript is mounted at `/privacyscript` in production
 * (tekdruid.com/privacyscript, see README "Deployment"), every URL that
 * points at /public must be prefixed with the basePath. Next handles this
 * for Image/Link automatically, but raw fetch / Web Worker `new URL()`
 * usage does not. Use this helper anywhere you'd otherwise write a literal
 * '/whatever.js'.
 *
 * In development set NEXT_PUBLIC_BASE_PATH= (empty) in .env.local to mount
 * at root so paths look like normal '/whatever.js'.
 *
 * IMPORTANT: .env.production sets NEXT_PUBLIC_BASE_PATH=/privacyscript so
 * every plain `npm run build` bakes in the correct prefix automatically.
 * If you forget to set it, this fallback catches the oversight.
 */
export const BASE_PATH =
  process.env.NEXT_PUBLIC_BASE_PATH !== undefined
    ? process.env.NEXT_PUBLIC_BASE_PATH   // empty string is a valid explicit choice
    : '/privacyscript';                    // safe default for production builds

export function asset(p: string): string {
  // Normalise: ensure exactly one leading slash on p, and no trailing slash on base.
  const path = p.startsWith('/') ? p : `/${p}`;
  return `${BASE_PATH}${path}`;
}
