/**
 * The client-held history a guest ask sends alongside its query — built entirely client-side from
 * the already-loaded thread, never a server round trip.
 */

import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, type AskHistoryMessageInput } from "@/shared/contracts/threads";
import { recentMessages, type GuestThread } from "@/lib/guest-thread-store";

/**
 * The thread's own recent turns, mapped to the wire shape. A turn whose content exceeds the
 * server's per-turn cap is DROPPED, never truncated — AskHistoryMessageInput's own contract
 * comment: "a turn over budget is dropped, not truncated." Truncating instead would silently send
 * a different (shorter) message than what the user actually said.
 */
export function toAskHistory(thread: GuestThread): AskHistoryMessageInput[] {
  return recentMessages(thread, MAX_HISTORY_TURNS)
    .filter((message) => message.content.length <= MAX_HISTORY_CHARS)
    .map((message) => ({ role: message.role, content: message.content }));
}
