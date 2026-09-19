/**
 * The JSON Schema sent to a provider for a zod response schema — Gemini's `responseJsonSchema`, and
 * the schema text shown in Gemma's system prompt. `ALLOWED_KEYWORDS` is an allowlist: Gemini rejects
 * length/bound/format constraints (`maxItems`, numeric bounds, string patterns) with 400
 * INVALID_ARGUMENT "too many states for serving", so only structural/descriptive keywords pass
 * through and a future zod-emitted constraint cannot reintroduce the failure. The zod schema itself
 * stays the server-side validator of the parsed output (structured-output.ts).
 */

import { z, type ZodType } from "zod";

/** Every JSON Schema keyword a provider may see; anything else is stripped by `toProviderJsonSchema`. */
export const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "nullable",
  "anyOf",
  "oneOf",
  "description",
  "title",
  "additionalProperties",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) continue;
    if (key === "properties" && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, sanitize(schema)]));
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      out[key] = value.map(sanitize);
    } else if (key === "items" || key === "additionalProperties") {
      out[key] = sanitize(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The zod schema's JSON Schema, sanitized to `ALLOWED_KEYWORDS` (`$schema`, which Gemini also rejects, is dropped too). */
export function toProviderJsonSchema(schema: ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema)) as Record<string, unknown>;
}
