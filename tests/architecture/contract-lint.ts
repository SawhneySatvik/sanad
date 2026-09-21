// Structural backstop for the wire contract's rules, run against the real zod schemas (their
// `_zod.def` trees), not a regex over source. Checks every RESPONSE schema exported from
// src/shared/contracts/** for a leaked quote/canonical-text/storage-ref key, a pass-through type, or an unlabelled model-written prose field.

import { z } from "zod";

type Schema = z.core.$ZodType;

export const PROSE_KEYS = new Set(["content", "explanation", "question", "whyItMatters", "item", "answer", "text", "summary", "markdown", "body"]);

// "checklist": a deterministic standard-clause gap (documents' FindingOutput) — not model text, and
// it implies no verification: such a finding is a quote-less missing_clause.
const PROVENANCE_VALUES = new Set(["ai_generated", "templated", "user_edited", "checklist"]);

export interface ProseSite {
  site: string;
  labelled: boolean;
}

export interface LintResult {
  violations: string[];
  prose: ProseSite[];
}

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional", "success"]);
const LEAVES = new Set(["string", "number", "boolean", "bigint", "literal", "enum", "null", "undefined", "date", "nan", "template_literal", "void", "never", "int", "file"]);

function def(schema: Schema) {
  return (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
}

// The literal values a provenance field accepts, or null if it is not a closed set of strings.
function closedValues(schema: Schema): string[] | null {
  const d = def(schema);
  if (d.type === "literal") return (d.values as unknown[]).every((v) => typeof v === "string") ? (d.values as string[]) : null;
  if (d.type === "enum") return Object.values(d.entries as Record<string, unknown>).every((v) => typeof v === "string") ? Object.values(d.entries as Record<string, string>) : null;
  return null;
}

// `names` maps a schema object to its exported name, so a sub-schema reached through another export
// is reported under its own name ("FindingOutput.explanation", not a path through every parent).
export function lintResponseSchema(name: string, schema: Schema, verificationOutput: Schema, names: Map<Schema, string> = new Map()): LintResult {
  const violations: string[] = [];
  const prose = new Map<string, boolean>();
  const onStack = new Set<Schema>();

  const walk = (node: Schema, at: string, inVerificationOutput: boolean): void => {
    if (onStack.has(node)) return;
    const here = names.get(node) ?? at;
    const inside = inVerificationOutput || node === verificationOutput;
    const d = def(node);
    onStack.add(node);
    switch (d.type) {
      case "object": {
        const shape = d.shape as Record<string, Schema>;
        const catchall = d.catchall as Schema | undefined;
        if (catchall && def(catchall).type !== "never") violations.push(`${here}: a catchall passes undeclared keys through`);
        for (const [key, child] of Object.entries(shape)) {
          const where = `${here}.${key}`;
          // `claimedQuote` is exempt only inside the shared VerificationOutput schema itself
          // (matched by reference, not by name — a look-alike union elsewhere gets no exemption).
          if (/quote/i.test(key) && !(key === "claimedQuote" && inside)) violations.push(`${where}: a quote-named key outside VerificationOutput.claimedQuote`);
          const flat = key.toLowerCase().replace(/[_-]/g, "");
          if (flat.includes("canonicaltext")) violations.push(`${where}: canonical text on the wire`);
          if (flat.includes("storageref")) violations.push(`${where}: a storage ref on the wire`);
          if (key.toLowerCase().includes("provenance")) {
            const values = closedValues(child);
            if (!values || !values.includes("ai_generated") || values.some((v) => !PROVENANCE_VALUES.has(v))) {
              violations.push(`${where}: provenance must be a closed set including "ai_generated", drawn from ${[...PROVENANCE_VALUES].join("/")}`);
            }
          }
          // Every model-written prose field (found by name) must carry a labelled provenance
          // sibling — a model-written field can never claim to be checked on its own.
          if (PROSE_KEYS.has(key)) {
            const label = shape.provenance ?? shape[`${key}Provenance`];
            const values = label ? closedValues(label) : null;
            const labelled = values !== null && values.includes("ai_generated");
            prose.set(where, (prose.get(where) ?? true) && labelled);
          }
          walk(child, where, inside);
        }
        break;
      }
      case "array":
        walk(d.element as Schema, `${here}[]`, inside);
        break;
      case "union":
        for (const option of d.options as Schema[]) walk(option, here, inside);
        break;
      case "intersection":
        walk(d.left as Schema, here, inside);
        walk(d.right as Schema, here, inside);
        break;
      case "tuple":
        (d.items as Schema[]).forEach((item, i) => walk(item, `${here}[${i}]`, inside));
        if (d.rest) walk(d.rest as Schema, `${here}[]`, inside);
        break;
      case "pipe":
        walk(d.in as Schema, here, inside);
        walk(d.out as Schema, here, inside);
        break;
      case "lazy":
        walk((d.getter as () => Schema)(), here, inside);
        break;
      case "record":
      case "map":
      case "any":
      case "unknown":
        violations.push(`${here}: z.${d.type}() lets undeclared keys through`);
        break;
      default:
        if (WRAPPERS.has(d.type)) walk(d.innerType as Schema, here, inside);
        else if (!LEAVES.has(d.type)) throw new Error(`${here}: contract-lint does not know zod type "${d.type}" — teach it before trusting a green run`);
    }
    onStack.delete(node);
  };

  walk(schema, name, false);
  return { violations, prose: [...prose].map(([site, labelled]) => ({ site, labelled })) };
}

export type ExportKind = "response" | "request" | "other";

// Anything not matched here must be listed in NON_SCHEMA_EXPORTS, so a response schema with an
// unexpected name cannot slip past unlinted.
export function classifyExport(name: string, nonSchemaExports: ReadonlySet<string>): ExportKind | null {
  if (name.endsWith("Output") || name === "ErrorBody") return "response";
  if (/(Input|Params|Query)$/.test(name)) return "request";
  if (nonSchemaExports.has(name)) return "other";
  return null;
}
