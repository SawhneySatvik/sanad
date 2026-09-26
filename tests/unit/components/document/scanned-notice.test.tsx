import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { ScannedNotice } from "@/components/document/scanned-notice";

const COPY =
  "This document was read from a scanned image. Saboot's transcription may contain errors, so its quotes are approximate at best — never verified.";

describe("ScannedNotice", () => {
  it("renders exactly one text, verbatim, on every surface", () => {
    render(<ScannedNotice inputMode="native_document" />);
    expect(screen.getByText(COPY)).toBeInTheDocument();
  });

  it("role=note, never role=alert — it never announces, unlike InlineNotice/OfflineBanner", () => {
    render(<ScannedNotice inputMode="native_document" />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("carries no aria-live region of its own — it is never one of the app's live regions", () => {
    const { container } = render(<ScannedNotice inputMode="native_document" />);
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(<ScannedNotice inputMode="native_document" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
