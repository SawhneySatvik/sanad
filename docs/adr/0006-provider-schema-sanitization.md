# 0006. The model schema carries no status, providers see a sanitized schema, and over-long output is trimmed

Status: Accepted

## Context

Structured output is how the model hands back findings, citations and draft sections. That design
has three risks:

1. **The model certifies itself.** If the response schema has a `status`, `verified` or span
   field, the model can mark its own output as checked. A successful prompt injection could then
   produce a "verified" claim.
2. **A strict provider rejects the schema.** Gemini compiles `responseJsonSchema` into a
   constrained-decoding state machine. It refuses schemas carrying array-length limits, numeric
   bounds or patterns with `400 INVALID_ARGUMENT` ("too many states for serving"). The zod caps
   that bound our own work leak into the provider-facing JSON Schema. A 4xx from the primary does
   not fall back (see [0007](0007-flat-fallback-chain.md)), so every analysis would fail. A mocked
   test suite cannot see this failure.
3. **A long answer is valid data.** A model that returns 45 findings when the cap is 40 has still
   produced usable output. Rejecting it wastes the call and the user's time.

## Decision

- **No status fields.** No response schema declares `status`, `verified`, `quote_span_start` or
  `quote_span_end`. `schema-guard.ts` runs before any provider call and throws on such a key, or on
  any pass-through construct (`looseObject`, `catchall`, `record`, `unknown`, `any`) that could
  carry one.
- **An allowlist for providers.** `toProviderJsonSchema()` keeps only structural and descriptive
  keywords (`type`, `properties`, `required`, `items`, `enum`, `nullable`, `anyOf`, `oneOf`,
  `description`, `title`, `additionalProperties`). An unknown keyword never reaches a provider, so
  a constraint zod adds in future cannot bring the rejection back. `additionalProperties` stays, so
  a provider cannot add a field.
- **zod stays the validator.** The zod schema still validates the parsed output on the server. A
  schema failure gets exactly one bounded repair retry.
- **Trim after parsing.** Caps that only bound work, such as the finding count or citations per
  answer, are applied after parsing. Exact repeats are dropped first, then the tail is cut.
  Understand, Prepare and Ask log an `llm_output_trimmed` event with the counts, so trimming is
  visible to operators.
- **Version pins.** A test hashes each prompt and response schema into a pin. The analysis cache
  keys on `PROMPT_VERSION`, so an edited prompt without a version bump would otherwise serve stale
  output.

Code: [`provider-schema.ts`](../../src/server/llm/provider-schema.ts),
[`schema-guard.ts`](../../src/server/llm/schema-guard.ts),
[`structured-output.ts`](../../src/server/llm/structured-output.ts).

## Consequences

- A prompt injection that succeeds still cannot make the model emit a trusted status.
- Providers may return more items than the cap. The server absorbs this and it costs nothing
  visible to the user.
- Provider 4xx messages are logged server-side (`llm_provider_rejected`), so a rejection can be
  diagnosed without exposing detail to the client.
- A schema change is only proven against a real provider by `npm run validate:live`. The mocked
  suite checks the sanitizer's output, not the provider's acceptance.
