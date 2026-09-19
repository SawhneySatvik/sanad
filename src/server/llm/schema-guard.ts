/**
 * Structural backstop: the LLM response schema must never let a `status`, `quote_span_start`, or
 * `quote_span_end` field through, even though `schema.safeParse` already strips unknown keys by
 * default — a schema that declares one directly, or is permissive (`looseObject`, `.catchall()`,
 * `z.record()`, `z.unknown()`), defeats that. Runs on the schema as authored, before
 * provider-schema.ts's sanitizer strips `$defs`/`not`/`allOf`/`prefixItems`, which would otherwise
 * hide a forbidden key nested under one of them. A schema-authoring error, not a live-request bug.
 */

import { z, type ZodType } from "zod";

// Canonicalized (lowercased, underscores stripped) so `quote_span_start`,
// `quoteSpanStart`, and `QUOTE_SPAN_START` are all caught the same way.
const FORBIDDEN_KEYS = new Set(["status", "verificationstatus", "verified", "quotespanstart", "quotespanend"]);

function canonicalize(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(node: unknown, path: string): void {
  if (!isPlainObject(node)) return;

  // An unconstrained node (`{}` — what `z.unknown()`/`z.any()` produce) could
  // hide an object with a forbidden key inside it undetected by everything
  // below, so it's rejected outright rather than silently skipped.
  if (Object.keys(node).length === 0) {
    throw new Error(
      `LlmClient schema guard: "${path}" is an unconstrained field (z.unknown()/z.any()/similar) — ` +
        `it could smuggle a status/quote_span_* field through undetected. Give it a concrete shape.`,
    );
  }

  const properties = node.properties;
  if (isPlainObject(properties)) {
    for (const key of Object.keys(properties)) {
      if (FORBIDDEN_KEYS.has(canonicalize(key))) {
        throw new Error(
          `LlmClient schema guard: "${path}.${key}" is a forbidden key — the LLM response schema must never ` +
            "include a status/verification/quote-span field. Only server-side verify() may set one.",
        );
      }
    }
  }

  // An object node that isn't explicitly closed (additionalProperties: false)
  // can carry an unnamed forbidden key under any key name at all —
  // `looseObject`/`.catchall()`/`z.record()` all produce this shape.
  if (node.type === "object" || properties !== undefined) {
    if (node.additionalProperties !== false) {
      throw new Error(
        `LlmClient schema guard: "${path}" does not set additionalProperties: false — a permissive object schema ` +
          "(looseObject/.catchall()/z.record()) could let a status/quote_span_* field through under any key name. " +
          "Use a plain z.object() (strict by default) instead.",
      );
    }
  }

  if (isPlainObject(properties)) {
    for (const [key, value] of Object.entries(properties)) walk(value, `${path}.${key}`);
  }
  if (isPlainObject(node.$defs)) {
    for (const [key, value] of Object.entries(node.$defs)) walk(value, `${path}.$defs.${key}`);
  }
  for (const key of ["items", "not"] as const) {
    if (node[key] !== undefined) walk(node[key], `${path}.${key}`);
  }
  for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"] as const) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}.${key}[${i}]`));
    }
  }
}

/** Throws a plain `Error` if `schema` could let a status/quote-span field through the model boundary. */
export function assertSafeResponseSchema(schema: ZodType): void {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  walk(jsonSchema, "$");
}
