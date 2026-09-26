# Security policy

## Supported versions

There is one supported line: `main`. There are no released versions or long-term-support branches,
so fixes land on `main` and there is nothing older to backport to.

## Reporting a vulnerability

Please report privately, using GitHub's built-in mechanism rather than a public issue or pull
request:

1. Go to this repository's **Security** tab.
2. Open **"Report a vulnerability"** to file a private security advisory.

Please include what you found, the file(s) or route(s) involved, and steps to reproduce. There is
no bug-bounty program.

## Threat model

This is a condensed restatement of the claims in
[README.md's "Security and privacy" section](README.md#security-and-privacy). If the two ever
disagree, the code — and the tests listed in the verification gate in
[CLAUDE.md](CLAUDE.md#verification-gate) — is the final authority, not this document.

- **The core promise.** A finding, quote or answer is only ever labelled `verified` after the
  server has confirmed that exact text exists in the canonical text it extracted from the
  document's own stored bytes, checked again on every read. No response schema, cache entry,
  fallback model or error-recovery path can set that label on its own. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-one-guarantee) for the ten channels this is
  checked across.
- **Identity and sessions.** A caller is either a guest or a signed-in user. Guest identity is an
  httpOnly, HMAC-signed, CSPRNG-generated cookie, verified with a constant-time comparison — never a
  client-supplied header or id. See
  [ADR 0009](docs/adr/0009-identity-and-authorization.md).
- **Authorization.** Every repository function takes a principal and goes through one `canAccess`
  chokepoint; an operation that touches more than one entity (a document pair, a save-to-project,
  an attachment) checks ownership of every one of them. A resource that exists but belongs to
  someone else returns the same 404 as one that doesn't exist at all, so existence is never
  disclosed by the response code.
- **Cross-site requests.** A state-changing request whose `Sec-Fetch-Site` reads `cross-site` (or
  `same-site` — this app is one origin with no CORS, so no legitimate caller is ever same-site) is
  refused before any cookie is read or minted.
- **Response headers.** Every response carries `x-content-type-options: nosniff`,
  `x-frame-options: DENY`, `cross-origin-opener-policy: same-origin`, `referrer-policy: no-referrer`,
  a `permissions-policy` denying camera/microphone/geolocation/payment/usb, `strict-transport-security`
  in production, and a `content-security-policy` restricting `default-src`, `script-src`, `style-src`,
  `img-src`, `font-src`, `connect-src`, `object-src`, `base-uri`, `form-action` and `frame-ancestors`.
- **Rate limiting.** Three independent tiers — per principal per model call, per IP on every route,
  and a global cap per provider — each an atomic increment, never a read-then-write. See
  [ADR 0005](docs/adr/0005-three-tier-rate-limiting.md).
- **Document text.** Canonical text is extracted from uploaded bytes on the server only, is never
  accepted as a client-supplied string, and the one route that serves it back is owner-checked and
  never cached.
- **Uploads.** A MIME allowlist plus byte/page/decompression caps apply at upload and again at
  extraction; PDF/DOCX parsing runs inside a resource-limited worker thread so a hostile file can
  only exhaust its own worker's budget.
- **Errors and logs.** Error responses and log lines never carry a raw exception message, a stack
  trace, a SQL statement or an environment value; a missing secret is reported by variable name
  only.
- **Database access.** Application tables carry no Data API/PostgREST grants for the
  `anon`/`authenticated` roles — a production-only migration revokes those grants and asserts none
  remain.

## Out of scope

`npm run validate:live` and the dev-only auth/e2e routes are development and validation tooling, not
part of the deployed attack surface described above. The dev-only routes refuse to run under
`NODE_ENV=production`.
