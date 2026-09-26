// toAskHistory: the client-held history a guest ask sends — capped at MAX_HISTORY_TURNS, with any
// single over-budget turn DROPPED rather than truncated (AskHistoryMessageInput's own contract
// comment). A dropped turn silently sending a truncated (different) message would be worse than
// omitting it.

import { describe, expect, it } from "vitest";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS } from "@/shared/contracts/threads";
import { appendMessage, createEmptyThread, type GuestMessage } from "@/lib/guest-thread-store";
import { toAskHistory } from "@/lib/guest-threads/history";

function userMessage(id: string, content: string): GuestMessage {
  return { id, role: "user", content, mode: null, citations: [], createdAtMs: Date.now() };
}

describe("toAskHistory", () => {
  it("maps the thread's recent messages to {role, content}, in chronological order", () => {
    let thread = createEmptyThread("t");
    thread = appendMessage(thread, userMessage("m1", "hello"));
    thread = appendMessage(thread, { id: "m2", role: "assistant", content: "hi", mode: "general", citations: [], createdAtMs: Date.now() });

    expect(toAskHistory(thread)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it(`caps at MAX_HISTORY_TURNS (${MAX_HISTORY_TURNS}), keeping only the most recent`, () => {
    let thread = createEmptyThread("t");
    for (let i = 0; i < MAX_HISTORY_TURNS + 5; i++) {
      thread = appendMessage(thread, userMessage(`m${i}`, `turn-${i}`));
    }
    const history = toAskHistory(thread);
    expect(history).toHaveLength(MAX_HISTORY_TURNS);
    expect(history[history.length - 1].content).toBe(`turn-${MAX_HISTORY_TURNS + 4}`);
  });

  it("drops (never truncates) a single turn whose content exceeds MAX_HISTORY_CHARS, keeping every other turn", () => {
    let thread = createEmptyThread("t");
    thread = appendMessage(thread, userMessage("m1", "short"));
    thread = appendMessage(thread, userMessage("m2", "x".repeat(MAX_HISTORY_CHARS + 1)));
    thread = appendMessage(thread, userMessage("m3", "also short"));

    const history = toAskHistory(thread);
    expect(history.map((m) => m.content)).toEqual(["short", "also short"]);
  });

  it("a turn exactly at the cap is kept, not dropped", () => {
    let thread = createEmptyThread("t");
    thread = appendMessage(thread, userMessage("m1", "x".repeat(MAX_HISTORY_CHARS)));
    expect(toAskHistory(thread)).toEqual([{ role: "user", content: "x".repeat(MAX_HISTORY_CHARS) }]);
  });

  it("an empty thread returns an empty history", () => {
    expect(toAskHistory(createEmptyThread("t"))).toEqual([]);
  });
});
