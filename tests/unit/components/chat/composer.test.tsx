// Composer's key unit-level behaviour: Enter submits, Shift+Enter inserts a newline.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "@/components/chat/composer";

function renderComposer(onSubmit: () => void, value = "hello") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper() {
    return (
      <QueryClientProvider client={queryClient}>
        <Composer
          value={value}
          onChange={() => undefined}
          onSubmit={onSubmit}
          attachments={[]}
          onRemoveAttachment={() => undefined}
          onAttached={() => undefined}
          isSignedIn={false}
        />
      </QueryClientProvider>
    );
  }
  return render(<Wrapper />);
}

describe("Composer — Enter/Shift+Enter", () => {
  it("Enter (no shift) submits", async () => {
    const onSubmit = vi.fn();
    renderComposer(onSubmit);
    const textarea = screen.getByLabelText("Ask Saboot");
    await userEvent.click(textarea);
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter inserts a newline and does NOT submit", async () => {
    const onSubmit = vi.fn();
    renderComposer(onSubmit);
    const textarea = screen.getByLabelText("Ask Saboot") as HTMLTextAreaElement;
    await userEvent.click(textarea);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter with an empty/whitespace-only value does not submit", async () => {
    const onSubmit = vi.fn();
    renderComposer(onSubmit, "   ");
    const textarea = screen.getByLabelText("Ask Saboot");
    await userEvent.click(textarea);
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
