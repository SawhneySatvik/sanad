/**
 * ask.ts's ThreadOutput -> the threads contract's wire shape. Owner columns are dropped by simply
 * never naming them; every message goes through threadMessageView, bound to this same result's own
 * `sources` — never put on the wire itself.
 */

import type { ThreadOutput as AskThreadOutput } from "@/server/services/ask";
import { threadMessageView } from "./message-view";

/** Maps a ThreadOutput to the wire shape. */
export function threadView(output: AskThreadOutput) {
  return {
    thread: {
      id: output.thread.id,
      projectId: output.thread.projectId,
      title: output.thread.title,
      createdAt: output.thread.createdAt,
      updatedAt: output.thread.updatedAt,
    },
    documentIds: output.documentIds,
    messages: output.messages.map((message) => threadMessageView(message, output.sources)),
  };
}
