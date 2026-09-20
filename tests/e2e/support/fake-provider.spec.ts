// Hold-and-release: the fake provider emits the first chunk of a streamed Ask answer, then holds
// the rest until this spec releases it — proving the assertion genuinely observes a mid-stream
// state, not a fast fake that finished before anyone looked (02-backend-slices.md §S5's own
// warning about this exact race). Uses the global fetch + a body reader directly, not Playwright's
// `request` fixture, which buffers a response's whole body before resolving.

import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import { registerScript, releaseHold, waitForHeldRequest } from "./fake-provider/client";

const STALL_CHECK_MS = 500;

// No resetFakeProvider() call here: the fake is one shared process across every project running in
// parallel, and a reset would clear scripts a concurrently-running instance of this same spec (a
// different project) just registered. Each test's randomUUID() nonce is already enough isolation.
test("a held stream is observed mid-stream, before release, and only completes after", async ({ baseURL, ip }) => {
  const nonce = `hold-${randomUUID()}`;
  await registerScript({
    id: nonce,
    match: nonce,
    chunks: ['{"answer":"first half ', 'second half","citations":[]}'],
    holdAfterChunk: 1,
  });

  const response = await fetch(`${baseURL}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ query: `${nonce} tell me about my lease` }),
  });
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let buffered = "";
  const readDeadline = Date.now() + 10_000;
  while (!buffered.includes("first half") && Date.now() < readDeadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  expect(buffered, "the preview text must arrive before the hold is released").toContain("first half");
  expect(buffered, "the held chunk must not have arrived yet").not.toContain("second half");

  // Proves the stream is genuinely stalled, not just unread: a read that would resolve immediately
  // if the fake had already finished must instead still be pending after a short wait. The reader
  // allows only one in-flight read() at a time, so this same pending promise — not a fresh read() —
  // is what the post-release drain below waits on first.
  const pendingRead = reader.read();
  const STILL_PENDING = Symbol("still-pending");
  const raced = await Promise.race([pendingRead, new Promise((resolve) => setTimeout(() => resolve(STILL_PENDING), STALL_CHECK_MS))]);
  expect(raced, "no further bytes should arrive while the fake is holding").toBe(STILL_PENDING);

  const requestId = await waitForHeldRequest(nonce);
  await releaseHold(requestId);

  const first = await pendingRead;
  if (!first.done && first.value) buffered += decoder.decode(first.value, { stream: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  expect(buffered, "the rest of the answer must arrive once released").toContain("second half");
});
