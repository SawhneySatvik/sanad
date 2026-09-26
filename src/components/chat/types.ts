/** Shared display shapes ChatScreen/MessageList/AssistantMessage pass between them — never a wire type by itself, so a citation's pending/failed/resolved lifecycle stays one shape regardless of source (a live stream, a signed-in GET, or a reopened local thread). */

import type { AskCitationOutput } from "@/shared/contracts/threads";

export type DisplayCitation =
  | { kind: "resolved"; citation: AskCitationOutput }
  | { kind: "pending"; sourceDocumentId: string; preview: string }
  | { kind: "failed"; sourceDocumentId: string; preview: string; onRetry: () => void };

export type DisplayMessageMode = "grounded" | "general" | null;

export interface DisplayMessage {
  /** Stable React key — a client-generated id for a guest turn, the server row id for a saved one. */
  id: string;
  role: "user" | "assistant";
  content: string;
  mode: DisplayMessageMode;
  citations: DisplayCitation[];
  modelUsed: string | null;
  /** GeneralAssistantMessageOutput.redirect — a redirect answer ran no model, so AssistantMessage omits ModelUsedNote when this is true. Always false for a user message/unknown. */
  redirect: boolean;
  createdAtMs: number;
}

export interface TurnError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}
