import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { UploadDropzone } from "@/components/upload/upload-dropzone";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UploadDropzone — keyboard reachability (no drag-and-drop-only path)", () => {
  it("Enter on the focused attach button opens the OS file picker (the hidden input's own click())", async () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<UploadDropzone onFilesSelected={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Attach a document" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("Space on the focused attach button also opens the picker", async () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<UploadDropzone onFilesSelected={vi.fn()} />);

    screen.getByRole("button", { name: "Attach a document" }).focus();
    await user.keyboard(" ");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("is a real <button>, reachable in the normal tab order", () => {
    render(<UploadDropzone onFilesSelected={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Attach a document" }).tagName).toBe("BUTTON");
  });
});

describe("UploadDropzone — file selection", () => {
  it("selecting a file through the OS picker calls onFilesSelected with the chosen file, unvalidated", async () => {
    const onFilesSelected = vi.fn();
    const { container } = render(<UploadDropzone onFilesSelected={onFilesSelected} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "lease.pdf", { type: "application/pdf" });

    await userEvent.upload(input, file);

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    expect(onFilesSelected).toHaveBeenCalledWith([file]);
  });

  it("clears the input's own value after a selection, so choosing the identical file twice still fires", async () => {
    const { container } = render(<UploadDropzone onFilesSelected={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "lease.pdf", { type: "application/pdf" });

    await userEvent.upload(input, file);
    expect(input.value).toBe("");
  });
});

describe("UploadDropzone — drag and drop (desktop)", () => {
  it("drop onto the dropzone's own bounding box selects the file", () => {
    const onFilesSelected = vi.fn();
    const { container } = render(<UploadDropzone onFilesSelected={onFilesSelected} />);
    const zone = container.querySelector('[data-slot="upload-dropzone"]') as HTMLElement;
    const file = new File(["hello"], "lease.pdf", { type: "application/pdf" });

    fireEvent.dragOver(zone, { dataTransfer: { files: [file] } });
    expect(zone).toHaveAttribute("data-dragover", "true");

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFilesSelected).toHaveBeenCalledWith([file]);
    expect(zone).not.toHaveAttribute("data-dragover");
  });

  it("dragleave clears the dragover state without selecting anything", () => {
    const onFilesSelected = vi.fn();
    const { container } = render(<UploadDropzone onFilesSelected={onFilesSelected} />);
    const zone = container.querySelector('[data-slot="upload-dropzone"]') as HTMLElement;

    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(zone).toHaveAttribute("data-dragover", "true");
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveAttribute("data-dragover");
    expect(onFilesSelected).not.toHaveBeenCalled();
  });

  it("a disabled dropzone ignores a drop", () => {
    const onFilesSelected = vi.fn();
    const { container } = render(<UploadDropzone onFilesSelected={onFilesSelected} disabled />);
    const zone = container.querySelector('[data-slot="upload-dropzone"]') as HTMLElement;
    const file = new File(["hello"], "lease.pdf", { type: "application/pdf" });

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFilesSelected).not.toHaveBeenCalled();
  });
});

describe("UploadDropzone — disabled state, with its reason shown", () => {
  it("disables the trigger and never hides it", () => {
    render(<UploadDropzone onFilesSelected={vi.fn()} disabled disabledReason="You're offline." />);
    expect(screen.getByRole("button", { name: "Attach a document" })).toBeDisabled();
  });

  it("names the reason in the description text, never silently", () => {
    render(<UploadDropzone onFilesSelected={vi.fn()} disabled disabledReason="You're offline." />);
    expect(screen.getByText(/You're offline\./)).toBeInTheDocument();
  });

  it("renders the reason as VISIBLE text, not only inside the sr-only hint — a disabled button can never take focus, so a description reachable only via aria-describedby-on-focus would never actually be read", () => {
    render(<UploadDropzone onFilesSelected={vi.fn()} disabled disabledReason="You're offline." />);
    const reasonNode = screen.getByText("You're offline.");
    expect(reasonNode.closest(".sr-only")).toBeNull();
  });
});

describe("UploadDropzone — accessibility", () => {
  it("aria-describedby names the accepted types and the size cap", () => {
    render(<UploadDropzone onFilesSelected={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Attach a document" });
    const describedById = button.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const description = document.getElementById(describedById!)?.textContent ?? "";
    expect(description).toContain("PDF, DOCX, or plain text");
    expect(description).toContain("15 MB");
  });

  it("has no axe violations at rest or while disabled", async () => {
    const idle = render(<UploadDropzone onFilesSelected={vi.fn()} />);
    expect(await axe(idle.container)).toHaveNoViolations();
    idle.unmount();

    const disabled = render(<UploadDropzone onFilesSelected={vi.fn()} disabled disabledReason="You're offline." />);
    expect(await axe(disabled.container)).toHaveNoViolations();
  });
});
