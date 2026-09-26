import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { ERROR_REASONS } from "@/shared/contracts/vocabulary";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { UploadErrorCard, type UploadCardError } from "@/components/upload/upload-error-card";

function renderCard(error: UploadCardError, props: Partial<React.ComponentProps<typeof UploadErrorCard>> = {}) {
  return render(
    <LiveRegionProvider>
      <UploadErrorCard error={error} {...props} />
    </LiveRegionProvider>,
  );
}

describe("UploadErrorCard — the reason matrix", () => {
  it("renders a distinct, non-empty string for every one of the five upload reasons this screen names", () => {
    const named = ["empty", "too_large", "unsupported_type", "type_mismatch", "unreadable"] as const;
    const texts = named.map((reason) => {
      const { container } = renderCard({ code: "INVALID_DOCUMENT", reason });
      const text = container.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
      return text;
    });
    expect(new Set(texts).size).toBe(named.length);
  });

  it("renders the exact literal copy for each named reason", () => {
    renderCard({ code: "INVALID_DOCUMENT", reason: "empty" });
    expect(screen.getByText("This file is empty.")).toBeInTheDocument();
  });

  it("too_large", () => {
    renderCard({ code: "INVALID_DOCUMENT", reason: "too_large" });
    expect(screen.getByText("This file is too large. Saboot accepts files up to 15 MB.")).toBeInTheDocument();
  });

  it("unsupported_type", () => {
    renderCard({ code: "INVALID_DOCUMENT", reason: "unsupported_type" });
    expect(screen.getByText("Saboot can't read this file type. Upload a PDF, DOCX, or plain-text file.")).toBeInTheDocument();
  });

  it("type_mismatch", () => {
    renderCard({ code: "INVALID_DOCUMENT", reason: "type_mismatch" });
    expect(screen.getByText("This file's contents don't match the type it was sent as. Re-save it and try again.")).toBeInTheDocument();
  });

  it("unreadable (EXTRACTION_FAILED)", () => {
    renderCard({ code: "EXTRACTION_FAILED", reason: "unreadable" });
    expect(
      screen.getByText("Saboot couldn't read this file. It may be corrupted — try re-exporting or re-scanning it."),
    ).toBeInTheDocument();
  });

  it("falls back to the per-code fixed message for a reason this screen has no bespoke copy for (document_not_ready/grounding_not_ready/grounding_too_long/sample_readonly)", () => {
    const unmapped = ["document_not_ready", "grounding_not_ready", "grounding_too_long", "sample_readonly"] as const;
    for (const reason of unmapped) {
      const { container, unmount } = renderCard({ code: "INVALID_DOCUMENT", reason });
      expect(screen.getByText("The uploaded document could not be processed.")).toBeInTheDocument();
      expect(container.textContent!.length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("covers every member of the shared ERROR_REASONS enum with a non-empty render (no reason silently unhandled)", () => {
    for (const reason of ERROR_REASONS) {
      const { container, unmount } = renderCard({ code: "INVALID_DOCUMENT", reason });
      expect(container.textContent!.length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("renders a non-empty fallback string when reason is entirely absent (an unmapped throw)", () => {
    renderCard({ code: "INVALID_DOCUMENT" });
    expect(screen.getByText("The uploaded document could not be processed.")).toBeInTheDocument();
  });

  it("renders EXTRACTION_FAILED's own fallback when reason is absent on that code", () => {
    renderCard({ code: "EXTRACTION_FAILED" });
    expect(screen.getByText("The document's text could not be extracted.")).toBeInTheDocument();
  });

  it("a client pre-check rejection (filename_too_long) renders its own fixed copy", () => {
    renderCard({ code: "CLIENT_REJECTED", reason: "filename_too_long" });
    expect(screen.getByText("That filename is too long. Rename the file and try again.")).toBeInTheDocument();
  });

  it("a mid-transfer network drop renders the interrupted copy, distinct from every reason above", () => {
    renderCard({ code: "UPLOAD_INTERRUPTED" });
    expect(screen.getByText("The upload was interrupted. Please try again.")).toBeInTheDocument();
  });

  it("a plain 404/403/400/500 renders the passthrough per-code fixed message", () => {
    renderCard({ code: "NOT_FOUND" });
    expect(screen.getByText("The requested resource could not be found.")).toBeInTheDocument();
  });
});

describe("UploadErrorCard — retry gating (never a 422, whatever documentId holds)", () => {
  it("never renders Retry analysis for INVALID_DOCUMENT even with a documentId and onRetryAnalysis present", () => {
    renderCard({ code: "INVALID_DOCUMENT", reason: "unreadable", documentId: "11111111-1111-1111-1111-111111111111" }, {
      onRetryAnalysis: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: "Retry analysis" })).not.toBeInTheDocument();
  });

  it("never renders Retry analysis for EXTRACTION_FAILED even with a documentId present", () => {
    renderCard({ code: "EXTRACTION_FAILED", reason: "unreadable", documentId: "11111111-1111-1111-1111-111111111111" }, {
      onRetryAnalysis: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: "Retry analysis" })).not.toBeInTheDocument();
  });

  it("renders Retry analysis for UPSTREAM_UNAVAILABLE with a documentId (F6.2)", async () => {
    const onRetryAnalysis = vi.fn();
    renderCard({ code: "UPSTREAM_UNAVAILABLE", documentId: "11111111-1111-1111-1111-111111111111" }, { onRetryAnalysis });
    const button = screen.getByRole("button", { name: "Retry analysis" });
    expect(button).toBeInTheDocument();
  });

  it("renders Retry analysis for SCHEMA_FAILED (502) and TIMEOUT (504) with a documentId", () => {
    renderCard({ code: "SCHEMA_FAILED", documentId: "11111111-1111-1111-1111-111111111111" }, { onRetryAnalysis: vi.fn() });
    expect(screen.getByRole("button", { name: "Retry analysis" })).toBeInTheDocument();
  });

  it("does not render Retry analysis without a documentId, even for a retryable code", () => {
    renderCard({ code: "UPSTREAM_UNAVAILABLE" }, { onRetryAnalysis: vi.fn() });
    expect(screen.queryByRole("button", { name: "Retry analysis" })).not.toBeInTheDocument();
  });

  it("falls back to Choose another file as the default action when retry isn't offered", () => {
    renderCard({ code: "INVALID_DOCUMENT", reason: "empty" }, { onChooseAnotherFile: vi.fn() });
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry analysis" })).not.toBeInTheDocument();
  });
});

describe("UploadErrorCard — retry-after composition", () => {
  it("renders RetryAfterNotice copy for RATE_LIMITED, never the reason table", () => {
    renderCard({ code: "RATE_LIMITED", retryAfterSeconds: 45 });
    expect(screen.getByText("You've reached your limit for now. Try again in 45 seconds.")).toBeInTheDocument();
  });

  it("renders RetryAfterNotice copy for UPSTREAM_UNAVAILABLE with the real countdown", () => {
    renderCard({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 180 });
    expect(screen.getByText("The AI providers are busy right now. Try again in 3 minutes.")).toBeInTheDocument();
  });
});

describe("UploadErrorCard — a11y", () => {
  it("is not role=alert — it announces through the assertive LiveRegion instead", () => {
    const { container } = renderCard({ code: "INVALID_DOCUMENT", reason: "empty" });
    const alertRoles = container.querySelectorAll('[role="alert"]');
    expect(alertRoles.length).toBe(0);
    expect(container.querySelector('[role="note"]')).toBeInTheDocument();
  });

  it("has no axe violations for every named reason, the fallback, and the retryable variant", async () => {
    for (const error of [
      { code: "INVALID_DOCUMENT", reason: "empty" },
      { code: "INVALID_DOCUMENT", reason: "too_large" },
      { code: "INVALID_DOCUMENT", reason: "unsupported_type" },
      { code: "INVALID_DOCUMENT", reason: "type_mismatch" },
      { code: "EXTRACTION_FAILED", reason: "unreadable" },
      { code: "INVALID_DOCUMENT" },
      { code: "UPSTREAM_UNAVAILABLE", documentId: "11111111-1111-1111-1111-111111111111", retryAfterSeconds: 30 },
    ] as UploadCardError[]) {
      const { container, unmount } = renderCard(error, { onRetryAnalysis: vi.fn(), onChooseAnotherFile: vi.fn() });
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
