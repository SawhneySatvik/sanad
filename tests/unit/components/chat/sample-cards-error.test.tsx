// A 503 (provider exhaustion) on a sample-open call often carries a real retryAfterSeconds — the
// caller must see that exact time, never a generic fallback that quietly loses it, the same
// discipline the chat stream's own StreamErrorNotice already applies.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { SampleCards } from "@/components/chat/sample-cards";
import { SAMPLE_CATALOGUE } from "@/components/chat/catalogue";

function renderCards(errors: Parameters<typeof SampleCards>[0]["errors"]) {
  return render(
    <LiveRegionProvider>
      <SampleCards samples={SAMPLE_CATALOGUE} onOpen={() => {}} errors={errors} />
    </LiveRegionProvider>,
  );
}

describe("SampleCards — inline error copy", () => {
  it("shows the real retry-after time for a 503, not the generic fallback", () => {
    renderCards({ lease: { code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 45 } });
    expect(screen.getByText("The AI providers are busy right now. Try again in 45 seconds.")).toBeInTheDocument();
  });

  it("falls back to the vague 503 copy only when no retry time was given", () => {
    renderCards({ lease: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(screen.getByText("The AI providers are busy right now. Try again in a few minutes.")).toBeInTheDocument();
  });

  it("keeps the 429 case distinct from the 503 case", () => {
    renderCards({ lease: { code: "RATE_LIMITED", retryAfterSeconds: 30 } });
    expect(screen.getByText("You've reached your limit for now. Try again in 30 seconds.")).toBeInTheDocument();
    expect(screen.queryByText(/providers are busy/)).not.toBeInTheDocument();
  });
});
