/**
 * Response headers every response carries: next.config.ts applies them to every path (pages, 404s,
 * static files), and route() sets them again on each API response so they hold wherever a handler
 * is called from. Next sends a header the config already set only once, so the overlap is free.
 *
 * HSTS omits `preload`: that submits the domain to browsers' built-in lists, which is slow to undo
 * and belongs with a custom domain, not a *.vercel.app deploy. The CSP carries only
 * `frame-ancestors` — nothing here renders a page yet; whoever adds pages must extend it
 * (script-src, style-src, connect-src and the rest) rather than replace it.
 */

/** Header name → value, applied to every response. Lower-case names, as the Fetch API reports them. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};
