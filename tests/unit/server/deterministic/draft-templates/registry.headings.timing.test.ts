import { describe, expect, it } from "vitest";
import { DRAFT_TEMPLATES, renderDraftContent } from "@/server/deterministic/draft-templates";
import { headingsIn } from "@tests/support/markdown/commonmark-blocks";

// The escape is applied to model-controlled text, so its cost must stay linear in the body's length.

const template = DRAFT_TEMPLATES.freelance_service_agreement;
const aiKey = template.sections.find((section) => section.provenance === "ai_generated")!.key;

function render(aiBody: string): string {
  return renderDraftContent(
    "freelance_service_agreement",
    template.sections.map((section) => ({
      sectionKey: section.key,
      content: section.provenance === "templated" ? section.body! : section.key === aiKey ? aiBody : "Plain model text.",
    })),
  );
}

describe("renderDraftContent — escaping cost", () => {
  it("a long run of markup characters is escaped in linear time", () => {
    const hostile = `${"-".repeat(200_000)}x\n${"=".repeat(200_000)}\n${"#".repeat(200_000)}`;

    const started = performance.now();
    const content = render(hostile);

    expect(performance.now() - started).toBeLessThan(500);
    expect(headingsIn(content)).toEqual(template.sections.map((section) => `## ${section.heading}`));
  });
});
