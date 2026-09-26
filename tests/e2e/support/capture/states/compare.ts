// Compare's own capture states. There is no recorded Compare sample, so the "comparison" state
// uploads two raw-text documents through the ordinary library path and scripts both the Understand
// analyze call (an empty findings array — this state is about Compare, not Understand's own
// findings) and the Compare call itself.

import type { StateRegistry, CaptureContext } from "../types";
import { registerScript } from "../../fake-provider/client";

const ANALYZE_PROMPT_MATCH = "You help people in India understand legal documents";
// The Compare call's own fixed system-prompt opening line (src/server/prompts/compare/compare.ts)
// — distinct from ANALYZE_PROMPT_MATCH above (no shared substring), so no per-run nonce is needed
// to tell the two calls apart, and neither document's own text has to carry a "(ref: ...)" marker
// sentence just to give the compare script something unique to match on.
const COMPARE_PROMPT_MATCH = "You help people in India understand how two versions of a legal document differ.";

interface UploadTarget {
  method: string;
  uploadUrl: string;
  ref: string;
}

async function uploadRawText(ctx: CaptureContext, filename: string, text: string): Promise<string> {
  const bytes = Buffer.from(text, "utf8");
  const targetResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/uploads`, {
    data: { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength },
  });
  const target = (await targetResponse.json()) as UploadTarget;
  await ctx.context.request.put(new URL(target.uploadUrl, ctx.baseUrl).toString(), { data: bytes });
  const confirmResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/documents`, {
    data: { storageRef: target.ref, filename, mimeType: "text/plain" },
  });
  const body = (await confirmResponse.json()) as { document: { id: string } };
  return body.document.id;
}

async function setUpComparison(ctx: CaptureContext): Promise<string> {
  // Registered before either upload — matched by the fixed opening sentence every findings-
  // extraction call shares, which never collides with COMPARE_PROMPT_MATCH below.
  await registerScript({ id: "compare-capture-analyze", match: ANALYZE_PROMPT_MATCH, chunks: [JSON.stringify({ findings: [] })] });

  const beforeText =
    "This services agreement is between a freelancer and a client for general consulting work. The monthly fee for these services is Rs. 10,000, payable by the fifth of each month. Either party may end this agreement with thirty days written notice.";
  const afterText =
    "This services agreement is between a freelancer and a client for general consulting work. The monthly fee for these services is Rs. 15,000, payable by the fifth of each month. Either party may end this agreement with thirty days written notice.";

  const documentAId = await uploadRawText(ctx, "before.txt", beforeText);
  const documentBId = await uploadRawText(ctx, "after.txt", afterText);

  // Registered only now, after both analyze calls have already fired against the broader script
  // above — matched by the compare prompt's own fixed sentence, never a per-run nonce.
  await registerScript({
    id: "compare-capture-compare",
    match: COMPARE_PROMPT_MATCH,
    chunks: [
      JSON.stringify({
        changes: [
          {
            id: "c1",
            explanation: "The monthly fee changed from Rs. 10,000 to Rs. 15,000.",
            quoteA: "Rs. 10,000",
            quoteB: "Rs. 15,000",
          },
        ],
      }),
    ],
  });

  const compareResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/comparisons`, {
    data: { documentAId, documentBId },
  });
  const body = (await compareResponse.json()) as { id: string };
  return body.id;
}

export const states: StateRegistry = {
  picker: {
    route: "/compare",
  },

  comparison: {
    route: "/compare/__pending__",
    setup: async (ctx) => {
      const id = await setUpComparison(ctx);
      states.comparison.route = `/compare/${id}`;
    },
  },

  "change-selected": {
    route: "/compare/__pending__",
    setup: async (ctx) => {
      const id = await setUpComparison(ctx);
      states["change-selected"].route = `/compare/${id}`;
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      if ((ctx.page.viewportSize()?.width ?? 0) < 768) {
        await ctx.page.getByRole("tab", { name: "Changes" }).click();
      } else {
        await ctx.page.getByRole("button", { name: "Summary of changes (1)" }).click();
      }
      await ctx.page.getByRole("button", { name: "Show this change" }).click();
      await ctx.page.locator("mark[data-active]").first().waitFor({ timeout: 5000 });
    },
  },

  error: {
    route: "/compare/00000000-0000-4000-8000-000000000000",
    expectStatus: (status) => status === 404 || status < 400,
  },
};
