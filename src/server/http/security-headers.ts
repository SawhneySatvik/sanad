/**
 * Response headers every response carries: next.config.ts applies them to every path (pages, 404s,
 * static files), and route() sets them again on each API response so they hold wherever a handler
 * is called from. Next sends a header the config already set only once, so the overlap is free.
 *
 * HSTS omits `preload` (that submits the domain to browsers' built-in lists, which is slow to undo
 * and belongs with a custom domain, not a *.vercel.app deploy) and is sent in production only —
 * over plain HTTP (a local `next start`, a preview without TLS) it would be a lie about the
 * connection that just carried it.
 *
 * The CSP has no per-request nonces, so it allows `'unsafe-inline'` scripts/styles — the App
 * Router inlines its own hydration payload as a script tag on every page, with no nonce threaded
 * through render to distinguish it from an injected one. Anyone tightening this must add nonces
 * end to end, not just delete `'unsafe-inline'`. `'unsafe-eval'` is added only under
 * `next dev` (including the e2e harness, which runs `next dev`) — React Fast Refresh needs it, and
 * neither a production build nor `next start` ever does.
 */

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

// `next dev`'s own build tooling (Turbopack/webpack + React Fast Refresh) evaluates code at
// runtime; a production build never does, so 'unsafe-eval' would only ever widen the policy for
// no reason there.
function scriptSrc(): string {
  const base = "script-src 'self' 'unsafe-inline'";
  return process.env.NODE_ENV === "development" ? `${base} 'unsafe-eval'` : base;
}

// Order matches the directives a browser reports back in a CSP violation report, so a report is
// grep-able against this literal string.
function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // next/font self-hosts every face this app uses at build time — no font-src exception needed
    // for a CDN. blob: covers a client-built download link (export-menu.tsx); nothing here loads an
    // <img> from anywhere but this origin.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    scriptSrc(),
    "style-src 'self' 'unsafe-inline'",
    // Over TLS in production any stray http:// subresource is fetched as https:// instead of
    // being mixed content; under plain-HTTP local dev it would break every request.
    ...(isProductionRuntime() ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Header name → value, applied to every response. Lower-case names, as the Fetch API reports them. */
export function securityHeaders(): Readonly<Record<string, string>> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // Belt-and-braces alongside the CSP's own frame-ancestors: X-Frame-Options is what a browser
    // too old to read frame-ancestors still honours.
    "cross-origin-opener-policy": "same-origin",
    // This app opens no popups of its own (no OAuth, no window.open) — same-origin is safe to set
    // unconditionally, not just a default one route happens to need.
    "referrer-policy": "no-referrer",
    // Another origin can't embed this app's responses (documents' text, API JSON) as a subresource.
    "cross-origin-resource-policy": "same-origin",
    // Ask the browser for a per-origin agent cluster, isolating this app's memory from same-site pages.
    "origin-agent-cluster": "?1",
    // No speculative DNS lookups for links a user never clicks, and no Flash/PDF cross-domain policy.
    "x-dns-prefetch-control": "off",
    "x-permitted-cross-domain-policies": "none",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "content-security-policy": contentSecurityPolicy(),
    ...(isProductionRuntime() ? { "strict-transport-security": "max-age=63072000; includeSubDomains" } : {}),
  };
}
