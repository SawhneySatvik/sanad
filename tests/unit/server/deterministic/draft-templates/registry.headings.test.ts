import { describe, expect, it } from "vitest";
import { DRAFT_TEMPLATES, renderDraftContent } from "@/server/deterministic/draft-templates";
import { fenceOpeners, headingsIn } from "@tests/support/markdown/commonmark-blocks";

// An ai_generated body is model text rendered as Markdown under the template's own headings; the
// detector is written from CommonMark's block rules, independently of the renderer.

const template = DRAFT_TEMPLATES.freelance_service_agreement;
const aiKey = template.sections.find((section) => section.provenance === "ai_generated")!.key;
const templateHeadings = template.sections.map((section) => `## ${section.heading}`);

function render(aiBody: string): string {
  return renderDraftContent(
    "freelance_service_agreement",
    template.sections.map((section) => ({
      sectionKey: section.key,
      content: section.provenance === "templated" ? section.body! : section.key === aiKey ? aiBody : "Plain model text.",
    })),
  );
}

describe("renderDraftContent — an ai_generated body cannot pose as template structure", () => {
  it("positive control: the detector finds the template's own headings, and a raw forged heading", () => {
    expect(headingsIn(render("Plain model text."))).toEqual(templateHeadings);
    expect(headingsIn("## Payment terms (templated)")).toEqual(["## Payment terms (templated)"]);
    expect(headingsIn("> - ## Signatures")).toEqual(["## Signatures"]);
    expect(headingsIn("Signatures\n---")).toEqual(["setext: Signatures"]);
    expect(headingsIn("Fees.\r## Signatures\rSignatures\r---")).toEqual(["## Signatures", "setext: Signatures"]);
    expect(fenceOpeners("  ```")).toEqual(["  ```"]);
  });

  it.each([
    ["an ATX heading", "## Payment terms (templated)"],
    ["an ATX heading after text", "Fees are due monthly.\n\n### Signatures"],
    ["a heading in a blockquote", "> ## Signatures"],
    ["a heading in a list item", "- ## Signatures\n1. # About This Draft"],
    ["a setext heading", "Payment terms (templated)\n=================="],
    ["a setext heading in a blockquote", "> Signatures\n> ---"],
    ["a setext heading in a list item", "- Signatures\n  ---"],
    ["an ATX heading after a lone carriage return", "Fees are due monthly.\r## Signatures"],
    ["a setext heading on lone carriage returns", "Fees are due monthly.\r\rSignatures (templated)\r---"],
    ["a setext heading on CRLF line endings", "Signatures\r\n==="],
  ])("negative: %s in the body leaves only the template's headings", (_, aiBody) => {
    expect(headingsIn(render(aiBody))).toEqual(templateHeadings);
  });

  it("negative: an unclosed code fence cannot swallow the headings after the body", () => {
    for (const fence of ["```", "~~~", "  ````js", "> ```"]) {
      const content = render(`Fees are due monthly.\n${fence}`);
      expect(fenceOpeners(content)).toEqual([]);
      expect(headingsIn(content)).toEqual(templateHeadings);
    }
  });

  it("the model's words survive: only the markup characters are escaped", () => {
    const content = render("Invoice #12 is due.\n- Milestone one\n- Milestone two");

    expect(content).toContain("Invoice \\#12 is due.\n- Milestone one\n- Milestone two");
  });

  it("templated bodies are never escaped", () => {
    const signatures = template.sections.find((section) => section.key === "signatures")!;

    expect(render("Plain model text.")).toContain(`## ${signatures.heading}\n\n${signatures.body}`);
  });
});
