// The schema a provider is sent must carry none of the keywords Gemini cannot serve (live: 400 on
// `maxItems: 40`), and sanitizing must only ever remove keywords, never a field or required entry.
// The sanitizer is an allowlist, so every keyword reaching a provider must be on it (fails closed).

import { describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";
import { DOCUMENT_TYPE_IDS } from "@/server/deterministic/document-type-registry";
import { DRAFTABLE_DOCUMENT_TYPE_IDS } from "@/server/deterministic/draft-templates";
import { specialistOutputSchema } from "@/server/orchestrator/schema";
import { compareResponseSchema } from "@/server/prompts/compare/compare";
import { buildDraftResponseSchema } from "@/server/prompts/draft/schema";
import { prepareResponseSchema } from "@/server/prompts/prepare/prepare";
import { buildUnderstandResponseSchema } from "@/server/prompts/understand/analyze";
import { transcriptionResponseSchema } from "@/server/prompts/understand/transcribe";
import { ALLOWED_KEYWORDS, toProviderJsonSchema } from "@/server/llm/provider-schema";

type Node = Record<string, unknown>;

// Counting, bound and format constraints — the kind that blows up Gemini's decoding state machine.
// multipleOf and uniqueItems were never on the denylist; the allowlist must drop them anyway.
const CONSTRAINT_KEYWORDS = [
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "multipleOf",
  "uniqueItems",
];

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every schema node in the tree with its path — property NAMES are path segments, never keywords.
function schemaNodes(node: unknown, path = "$"): [string, Node][] {
  if (!isNode(node)) return [];
  const found: [string, Node][] = [[path, node]];
  for (const key of ["properties", "$defs"]) {
    if (isNode(node[key])) {
      for (const [name, child] of Object.entries(node[key])) found.push(...schemaNodes(child, `${path}.${key}.${name}`));
    }
  }
  for (const key of ["items", "not", "additionalProperties"]) found.push(...schemaNodes(node[key], `${path}.${key}`));
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = node[key];
    if (Array.isArray(list)) list.forEach((child, i) => found.push(...schemaNodes(child, `${path}.${key}[${i}]`)));
  }
  return found;
}

function keywordsUsed(jsonSchema: unknown): Set<string> {
  return new Set(schemaNodes(jsonSchema).flatMap(([, node]) => Object.keys(node)));
}

// Per node: its field names, required list and additionalProperties — what the model may answer.
function fieldsOf(jsonSchema: unknown) {
  return schemaNodes(jsonSchema).map(([path, node]) => ({
    path,
    properties: isNode(node.properties) ? Object.keys(node.properties) : null,
    required: node.required ?? null,
    additionalProperties: node.additionalProperties === false ? false : null,
  }));
}

const REAL_SCHEMAS: [string, ZodType][] = [
  ...DOCUMENT_TYPE_IDS.map((type): [string, ZodType] => [`understand:${type}`, buildUnderstandResponseSchema(type)]),
  ["understand:transcription", transcriptionResponseSchema],
  ["compare", compareResponseSchema],
  ["prepare", prepareResponseSchema],
  ...DRAFTABLE_DOCUMENT_TYPE_IDS.map((type): [string, ZodType] => [`draft:${type}`, buildDraftResponseSchema(type)]),
  ["orchestrator:specialist", specialistOutputSchema],
];

describe("toProviderJsonSchema — a synthetic schema using every constraint keyword", () => {
  const synthetic = z.object({
    findings: z
      .array(
        z.object({
          score: z.number().min(1).max(5),
          ratio: z.number().gt(0).lt(1),
          step: z.number().multipleOf(5),
          label: z.string().min(1).max(40).regex(/^[a-z]+$/),
          email: z.email(),
          when: z.iso.datetime(),
          ids: z.array(z.string()).min(1).max(20),
          tags: z.array(z.string()).meta({ uniqueItems: true }),
          kind: z.enum(["lease", "nda"]),
          // Property NAMES that collide with stripped keywords: fields, so they must survive.
          pattern: z.string(),
          format: z.string().nullable(),
          maxItems: z.number(),
        }),
      )
      .min(1)
      .max(40),
  });

  it("the fixture really exercises every constraint keyword (positive control)", () => {
    const raw = keywordsUsed(z.toJSONSchema(synthetic));
    for (const keyword of CONSTRAINT_KEYWORDS) expect(raw, keyword).toContain(keyword);
  });

  it("strips every one of them, at every depth, plus $schema — and sends nothing that is not on the allowlist", () => {
    const sent = toProviderJsonSchema(synthetic);
    // Checked on its own, not only through the keyword lists: it is the one Gemini rejected live.
    expect(JSON.stringify(sent)).not.toMatch(/"maxItems":\d/);
    const used = keywordsUsed(sent);
    for (const keyword of CONSTRAINT_KEYWORDS) expect(used, keyword).not.toContain(keyword);
    for (const keyword of used) expect(ALLOWED_KEYWORDS, keyword).toContain(keyword);
    expect(sent).not.toHaveProperty("$schema");
  });

  it("keeps every field — including ones named pattern/format/maxItems — and its type, required list, enum and nullability", () => {
    const sent = toProviderJsonSchema(synthetic);
    expect(fieldsOf(sent)).toEqual(fieldsOf(z.toJSONSchema(synthetic)));
    const item = (sent.properties as Node).findings as Node;
    const fields = (item.items as Node).properties as Record<string, Node>;
    expect(Object.keys(fields)).toEqual([
      "score",
      "ratio",
      "step",
      "label",
      "email",
      "when",
      "ids",
      "tags",
      "kind",
      "pattern",
      "format",
      "maxItems",
    ]);
    expect(fields.kind).toEqual({ type: "string", enum: ["lease", "nda"] });
    expect(fields.pattern).toEqual({ type: "string" });
    expect(fields.format).toEqual({ type: ["string", "null"] });
    expect(fields.ids).toEqual({ type: "array", items: { type: "string" } });
    expect(fields.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(fields.step).toEqual({ type: "number" });
  });

  it("zod still enforces the stripped constraints on the parsed output (server-side validator)", () => {
    const item = {
      score: 3,
      ratio: 0.5,
      step: 10,
      label: "abc",
      email: "a@example.com",
      when: "2026-01-01T00:00:00Z",
      ids: ["x"],
      tags: ["t"],
      kind: "nda",
      pattern: "p",
      format: null,
      maxItems: 1,
    };
    expect(synthetic.safeParse({ findings: Array.from({ length: 40 }, () => item) }).success).toBe(true);
    expect(synthetic.safeParse({ findings: Array.from({ length: 41 }, () => item) }).success).toBe(false);
    expect(synthetic.safeParse({ findings: [{ ...item, label: "ABC" }] }).success).toBe(false);
    expect(synthetic.safeParse({ findings: [{ ...item, kind: "will" }] }).success).toBe(false);
  });
});

describe.each(REAL_SCHEMAS)("toProviderJsonSchema — real response schema %s", (_name, schema) => {
  it("sends no constraint keyword, no $schema, and nothing off the allowlist", () => {
    const sent = toProviderJsonSchema(schema);
    const used = keywordsUsed(sent);
    for (const keyword of CONSTRAINT_KEYWORDS) expect(used, keyword).not.toContain(keyword);
    for (const keyword of used) expect(ALLOWED_KEYWORDS, keyword).toContain(keyword);
    expect(sent).not.toHaveProperty("$schema");
  });

  it("keeps exactly the fields, required lists and additionalProperties: false of the zod schema", () => {
    expect(fieldsOf(toProviderJsonSchema(schema))).toEqual(fieldsOf(z.toJSONSchema(schema)));
  });

  it("matches the pinned provider-facing shape", () => {
    expect(toProviderJsonSchema(schema)).toMatchSnapshot();
  });
});
