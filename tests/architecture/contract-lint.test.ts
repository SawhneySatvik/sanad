// Contract lint over every response schema in src/shared/contracts/**, proven below against
// schemas that break each rule. See ./contract-lint.ts for the rules.

import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { beforeAll, describe, expect, it } from "vitest";
import { VerificationOutput } from "@/shared/contracts/common";
import { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import { classifyExport, lintResponseSchema, type ProseSite } from "./contract-lint";

const CONTRACTS_DIR = path.join(process.cwd(), "src", "shared", "contracts");

// Exported zod values that are neither a request nor a response schema.
const NON_SCHEMA_EXPORTS = new Set(["IsoDateTime"]);

// Model-written prose that deliberately carries no provenance sibling, and why.
const EXEMPT_PROSE: Record<string, string> = {
  "UserMessageOutput.content": "the user's own message, not model text",
  "AskTokenEventOutput.text":
    "an SSE token fragment of the final message's content, which carries provenance; a sibling test pins a token frame to exactly {type, text}",
  "DraftOutput.content": "the flattened sections, shipped beside `sections`, each carrying its own provenance (drafts.test.ts pins both present)",
  "PrepareOutput.markdown": "renderer-owned Markdown; every model-written line carries a fixed \"AI-suggested\" prefix",
};

// Routed known gaps: none. This list must match the tree exactly: a new unlabelled prose field
// fails the test below until it is labelled, exempted with a reason, or routed here.
const PENDING_PROSE: string[] = [];

// Positive control: the sites the lint must see as labelled.
const LABELLED_PROSE = [
  "GroundedAssistantMessageOutput.content",
  "GeneralAssistantMessageOutput.content",
  "PrepareOutput.lawyerQuestions[].question",
  "PrepareOutput.lawyerQuestions[].whyItMatters",
  "PrepareOutput.checklist[].item",
  "DraftSectionOutput.content",
  "ComparisonOutput.changes[].explanation",
];

const KNOWN_RESPONSES = [
  "ErrorBody",
  "DocumentWithFindingsOutput",
  "AnalyzeDocumentOutput",
  "ComparisonWithChangesOutput",
  "DraftWithSectionsOutput",
  "PrepareOutput",
  "MessagesOutput",
  "ThreadOutput",
  "AskEventOutput",
  "VerifyBatchOutput",
  "ProjectDetailOutput",
  "SaveToProjectOutput",
  "UploadTargetOutput",
  "HealthOutput",
  "ClaimResultOutput",
];

type Schema = z.core.$ZodType;
const isZod = (value: unknown): value is Schema => typeof value === "object" && value !== null && "_zod" in value;

interface Discovered {
  file: string;
  exportName: string;
  schema: Schema;
}

const discovered: Discovered[] = [];
let names: Map<Schema, string>;

beforeAll(async () => {
  const files = readdirSync(CONTRACTS_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  for (const file of files) {
    const mod = (await import(path.join(CONTRACTS_DIR, file))) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod).sort(([a], [b]) => a.localeCompare(b))) {
      if (isZod(value)) discovered.push({ file, exportName, schema: value });
    }
  }
  // An alias (ComparisonOutput = ComparisonWithChangesOutput) is reported under its first name.
  names = new Map();
  for (const { exportName, schema } of discovered) if (!names.has(schema)) names.set(schema, exportName);
});

const responses = () => discovered.filter((d) => classifyExport(d.exportName, NON_SCHEMA_EXPORTS) === "response");

function proseSites(): ProseSite[] {
  const merged = new Map<string, boolean>();
  for (const { exportName, schema } of responses()) {
    for (const { site, labelled } of lintResponseSchema(exportName, schema, VerificationOutput, names).prose) {
      merged.set(site, (merged.get(site) ?? true) && labelled);
    }
  }
  return [...merged].map(([site, labelled]) => ({ site, labelled }));
}

describe("the real contracts", () => {
  it("every exported zod schema is classified as a request or a response (none can escape the lint)", () => {
    const unclassified = discovered.filter((d) => classifyExport(d.exportName, NON_SCHEMA_EXPORTS) === null).map((d) => `${d.file}#${d.exportName}`);
    expect(unclassified).toEqual([]);
  });

  it("discovery finds every known response schema (positive control)", () => {
    const found = responses().map((d) => d.exportName);
    expect(found).toEqual(expect.arrayContaining(KNOWN_RESPONSES));
    expect(found.length).toBeGreaterThanOrEqual(KNOWN_RESPONSES.length);
  });

  it("no response schema carries a quote (other than VerificationOutput.claimedQuote), canonical text, a storage ref or a pass-through", () => {
    const violations = responses().flatMap(({ file, exportName, schema }) =>
      lintResponseSchema(exportName, schema, VerificationOutput, names).violations.map((v) => `${file}: ${v}`),
    );
    expect(violations).toEqual([]);
  });

  it("claimedQuote does reach the wire, and only inside VerificationOutput (the exemption is live, not vacuous)", () => {
    const { violations } = lintResponseSchema("VerifyBatchOutput", responses().find((d) => d.exportName === "VerifyBatchOutput")!.schema, VerificationOutput, names);
    expect(violations).toEqual([]);
    const shapes = (VerificationOutput as unknown as { options: { shape: Record<string, unknown> }[] }).options.map((o) => Object.keys(o.shape));
    expect(shapes.filter((keys) => keys.includes("claimedQuote"))).toHaveLength(2);
  });

  it("every model-written prose field is labelled, exempt with a reason, or a routed known gap — and both lists match the tree exactly", () => {
    const sites = proseSites();
    const unlabelled = sites.filter((s) => !s.labelled).map((s) => s.site).sort();
    const labelled = sites.filter((s) => s.labelled).map((s) => s.site);

    expect(labelled).toEqual(expect.arrayContaining(LABELLED_PROSE));
    expect(unlabelled.filter((s) => !(s in EXEMPT_PROSE))).toEqual([...PENDING_PROSE].sort());
    for (const exempt of Object.keys(EXEMPT_PROSE)) expect(unlabelled, `stale exemption ${exempt}`).toContain(exempt);
  });
});

describe("lintResponseSchema flags each rule's breach", () => {
  const lint = (schema: Schema) => lintResponseSchema("T", schema, VerificationOutput).violations;

  it("a quote-named key, top level or nested, any casing", () => {
    expect(lint(z.object({ quote: z.string() }))).toEqual(["T.quote: a quote-named key outside VerificationOutput.claimedQuote"]);
    expect(lint(z.object({ items: z.array(z.object({ modelQuote: z.string().nullable() })) }))).toEqual([
      "T.items[].modelQuote: a quote-named key outside VerificationOutput.claimedQuote",
    ]);
    expect(lint(z.object({ QUOTE_TEXT: z.string() }))).toHaveLength(1);
  });

  it("flags quoteA re-added beside the real comparison change's verification", () => {
    const change = ComparisonWithChangesOutput.shape.changes.element.extend({ quoteA: z.string() });
    const regressed = ComparisonWithChangesOutput.extend({ changes: z.array(change) });
    expect(lint(regressed)).toEqual(["T.changes[].quoteA: a quote-named key outside VerificationOutput.claimedQuote"]);
    expect(lint(ComparisonWithChangesOutput)).toEqual([]);
  });

  it("claimedQuote is exempt by reference to VerificationOutput, never by name", () => {
    expect(lint(z.object({ claimedQuote: z.string() }))).toHaveLength(1);
    const lookAlike = z.discriminatedUnion("status", [z.object({ status: z.literal("not_found"), claimedQuote: z.string() })]);
    expect(lint(z.object({ verification: lookAlike }))).toEqual(["T.verification.claimedQuote: a quote-named key outside VerificationOutput.claimedQuote"]);
    expect(lint(z.object({ verification: VerificationOutput.nullable() }))).toEqual([]);
  });

  it("canonical text or a storage ref, in any spelling", () => {
    expect(lint(z.object({ canonicalText: z.string() }))).toEqual(["T.canonicalText: canonical text on the wire"]);
    expect(lint(z.object({ doc: z.object({ canonical_text_hash: z.string() }) }))).toEqual(["T.doc.canonical_text_hash: canonical text on the wire"]);
    expect(lint(z.object({ rows: z.array(z.object({ storage_ref: z.string() })) }))).toEqual(["T.rows[].storage_ref: a storage ref on the wire"]);
    expect(lint(z.object({ storageRef: z.string().optional() }))).toEqual(["T.storageRef: a storage ref on the wire"]);
  });

  it("a pass-through: loose object, catchall, record, unknown", () => {
    expect(lint(z.looseObject({ id: z.string() }))).toEqual(["T: a catchall passes undeclared keys through"]);
    expect(lint(z.object({ id: z.string() }).catchall(z.string()))).toHaveLength(1);
    expect(lint(z.object({ meta: z.record(z.string(), z.string()) }))).toEqual(["T.meta: z.record() lets undeclared keys through"]);
    expect(lint(z.object({ raw: z.unknown() }))).toEqual(["T.raw: z.unknown() lets undeclared keys through"]);
    expect(lint(z.strictObject({ id: z.string() }))).toEqual([]);
  });

  it("a provenance that could imply verification, or is not a closed set", () => {
    expect(lint(z.object({ content: z.string(), provenance: z.enum(["ai_generated", "verified"]) }))).toHaveLength(1);
    expect(lint(z.object({ content: z.string(), provenance: z.string() }))).toHaveLength(1);
    expect(lint(z.object({ content: z.string(), provenance: z.literal("templated") }))).toHaveLength(1);
    expect(lint(z.object({ content: z.string(), provenance: z.literal("ai_generated") }))).toEqual([]);
    expect(lint(z.object({ content: z.string(), provenance: z.enum(["ai_generated", "checklist"]) }))).toEqual([]);
    expect(lint(z.object({ content: z.string(), provenance: z.literal("checklist") }))).toHaveLength(1);
  });

  it("an unlabelled prose field is reported unlabelled; a labelled one labelled", () => {
    const prose = (schema: Schema) => lintResponseSchema("T", schema, VerificationOutput).prose;
    expect(prose(z.object({ items: z.array(z.object({ explanation: z.string() })) }))).toEqual([{ site: "T.items[].explanation", labelled: false }]);
    expect(prose(z.object({ explanation: z.string(), explanationProvenance: z.enum(["ai_generated", "templated"]) }))).toEqual([{ site: "T.explanation", labelled: true }]);
    // A field reached through two union branches is labelled only if BOTH label it.
    expect(prose(z.union([z.object({ content: z.string(), provenance: z.literal("ai_generated") }), z.object({ content: z.string() })]))).toEqual([
      { site: "T.content", labelled: false },
    ]);
  });

  it("a zod node type the walker does not know throws rather than passing silently", () => {
    expect(() => lint(z.object({ x: z.custom<string>() }))).toThrow(/does not know zod type "custom"/);
  });

  it("an export named outside the conventions is unclassified", () => {
    expect(classifyExport("DocumentResponse", NON_SCHEMA_EXPORTS)).toBeNull();
    expect(classifyExport("DocumentOutput", NON_SCHEMA_EXPORTS)).toBe("response");
    expect(classifyExport("IdParams", NON_SCHEMA_EXPORTS)).toBe("request");
  });
});
