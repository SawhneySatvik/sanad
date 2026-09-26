import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSafeResponseSchema } from "@/server/llm/schema-guard";

describe("assertSafeResponseSchema", () => {
  it("accepts a plain z.object() schema", () => {
    expect(() => assertSafeResponseSchema(z.object({ answer: z.string() }))).not.toThrow();
  });

  it("accepts a nested, strict schema (array of objects, $defs via z.lazy-free recursion not required here)", () => {
    expect(() =>
      assertSafeResponseSchema(
        z.object({ answer: z.string(), items: z.array(z.object({ x: z.string() })) }),
      ),
    ).not.toThrow();
  });

  it.each(["status", "verification_status", "verified", "quote_span_start", "quote_span_end"])(
    "rejects a schema declaring the forbidden key %s",
    (key) => {
      const badSchema = z.object({ answer: z.string(), [key]: z.string() });
      expect(() => assertSafeResponseSchema(badSchema)).toThrow(/forbidden key/);
    },
  );

  it("rejects a forbidden key regardless of case/underscore convention (quoteSpanStart)", () => {
    const badSchema = z.object({ answer: z.string(), quoteSpanStart: z.number() });
    expect(() => assertSafeResponseSchema(badSchema)).toThrow(/forbidden key/);
  });

  it("rejects a forbidden key nested inside an array of objects", () => {
    const badSchema = z.object({ answer: z.string(), items: z.array(z.object({ verified: z.boolean() })) });
    expect(() => assertSafeResponseSchema(badSchema)).toThrow(/forbidden key/);
  });

  it("the forbidden-key error explains itself without pointing into docs", () => {
    const badSchema = z.object({ answer: z.string(), status: z.string() });
    expect(() => assertSafeResponseSchema(badSchema)).not.toThrow(/docs\//);
    expect(() => assertSafeResponseSchema(badSchema)).toThrow(
      /must never include a status\/verification\/quote-span field\. Only server-side verify\(\) may set one\.$/,
    );
  });

  it("rejects z.looseObject() (additionalProperties not false)", () => {
    expect(() => assertSafeResponseSchema(z.looseObject({ answer: z.string() }))).toThrow(/additionalProperties/);
  });

  it("rejects .catchall(z.unknown())", () => {
    expect(() => assertSafeResponseSchema(z.object({ answer: z.string() }).catchall(z.unknown()))).toThrow(
      /additionalProperties/,
    );
  });

  it("rejects z.record()", () => {
    expect(() => assertSafeResponseSchema(z.record(z.string(), z.unknown()))).toThrow(/additionalProperties/);
  });

  it("rejects an unconstrained field (z.unknown()/z.any()) anywhere in the tree — could hide a forbidden key", () => {
    expect(() => assertSafeResponseSchema(z.object({ answer: z.string(), meta: z.unknown() }))).toThrow(
      /unconstrained/,
    );
    expect(() => assertSafeResponseSchema(z.object({ answer: z.string(), meta: z.any() }))).toThrow(/unconstrained/);
  });

  it("throws a plain Error, not an AppError — this is a programmer-error check, not a runtime provider failure", () => {
    try {
      assertSafeResponseSchema(z.object({ status: z.string() }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("code");
    }
  });

  it("rejects a forbidden key hidden inside a $defs entry — a named/reused sub-schema, not inlined at its use site", () => {
    // A schema given an id (or reused via a shared registry) is hoisted into JSON Schema's own
    // $defs and referenced with $ref, rather than inlined — the walk must follow $defs too, not
    // just each property in place.
    const shared = z.object({ verified: z.boolean() }).meta({ id: "SharedAnswer" });
    const badSchema = z.object({ a: shared, b: shared });
    expect(() => assertSafeResponseSchema(badSchema)).toThrow(/forbidden key/);
  });

  it("a $defs entry with no forbidden key is accepted", () => {
    const shared = z.object({ text: z.string() }).meta({ id: "SharedText" });
    const okSchema = z.object({ a: shared, b: shared });
    expect(() => assertSafeResponseSchema(okSchema)).not.toThrow();
  });

  it("rejects a forbidden key hidden inside a union member (anyOf) — z.union's own JSON Schema shape", () => {
    const badSchema = z.object({ answer: z.union([z.object({ verified: z.boolean() }), z.string()]) });
    expect(() => assertSafeResponseSchema(badSchema)).toThrow(/forbidden key/);
  });

  it("a union with no forbidden key anywhere in its members is accepted", () => {
    const okSchema = z.object({ answer: z.union([z.object({ text: z.string() }), z.string()]) });
    expect(() => assertSafeResponseSchema(okSchema)).not.toThrow();
  });
});
