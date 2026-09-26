import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { UploadRetentionNotice } from "@/components/upload/upload-retention-notice";

function renderNotice(props: React.ComponentProps<typeof UploadRetentionNotice>) {
  return render(
    <LiveRegionProvider>
      <UploadRetentionNotice {...props} />
    </LiveRegionProvider>,
  );
}

describe("UploadRetentionNotice", () => {
  it("reads guestTtlHours from the caller, never a hard-coded number", () => {
    renderNotice({ isSignedIn: false, guestTtlHours: 7 });
    expect(screen.getByText("Guest documents are deleted after about 7 hours.")).toBeInTheDocument();
  });

  it("renders nothing while ['session'] is still loading or has failed — guestTtlHours undefined", () => {
    const { container } = renderNotice({ isSignedIn: false, guestTtlHours: undefined });
    expect(container.textContent).toBe("");
  });

  it("never renders for a signed-in user, even if guestTtlHours is somehow present", () => {
    const { container } = renderNotice({ isSignedIn: true, guestTtlHours: 4 });
    expect(container.textContent).toBe("");
  });

  it("never mentions signing in — that's the second-upload nudge's own job, not this notice's", () => {
    renderNotice({ isSignedIn: false, guestTtlHours: 4 });
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
  });

  it("has no axe violations when rendered", async () => {
    const { container } = renderNotice({ isSignedIn: false, guestTtlHours: 4 });
    expect(await axe(container)).toHaveNoViolations();
  });
});
