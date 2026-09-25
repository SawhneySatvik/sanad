import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimGuestData } from "@/server/auth/claim";
import type { Principal } from "@/server/core/types";
import { deleteLibraryRow } from "@/server/data/library";
import { create } from "@/server/services/draft";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, draftModelOutput, guestA, readyDocument, userA, type Harness } from "@tests/support/services/draft";

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

function heldModel() {
  const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("grounded_response") } });
  let resume!: () => void;
  let started!: () => void;
  const waitForStart = new Promise<void>((resolve) => { started = resolve; });
  const waitForResume = new Promise<void>((resolve) => { resume = resolve; });
  const complete = llm.complete.bind(llm);
  vi.spyOn(llm, "complete").mockImplementation(async (input) => {
    started();
    await waitForResume;
    return complete(input);
  });
  return { llm, waitForStart, resume };
}

const input = (groundingDocumentId: string) => ({ mode: "document_grounded" as const,
  documentType: "grounded_response" as const, groundingDocumentId,
  userInstructions: "Explain the response terms.", jurisdiction: "IN" });

describe("grounded draft persistence after a held model call", () => {
  it("returns the same 404 when a guest document is claimed during the model call", async () => {
    const document = await readyDocument(h.t, guestA);
    const held = heldModel();
    const pending = create(h.deps(held.llm), guestA, input(document.id));
    await held.waitForStart;
    await claimGuestData(h.t.db, guestA as Extract<Principal, { type: "guest" }>, userA as Extract<Principal, { type: "user" }>);
    held.resume();
    await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await h.counts()).drafts).toBe(0);
  });

  it("returns 404 if the grounding document is deleted during the model call", async () => {
    const document = await readyDocument(h.t, guestA);
    const held = heldModel();
    const pending = create(h.deps(held.llm), guestA, input(document.id));
    await held.waitForStart;
    await deleteLibraryRow(h.t.db, guestA, "document", document.id);
    held.resume();
    await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await h.counts()).drafts).toBe(0);
  });
});
