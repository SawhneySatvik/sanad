"use client";

/**
 * Renders both /chat (chatId null) and /chat/[chatId]: one component owns every bit of chat state
 * itself. chatId is read once on mount (a prop, not re-derived from the URL on every render) — an
 * internal id swap (home -> local-<uuid>, or local-<uuid> -> a real server id) never triggers a
 * Next route change, only window.history.replaceState. This is why the component tree, the open
 * stream reader and its AbortController all stay mounted straight through the swap, so an in-flight
 * stream is never aborted by its own success. Reloading the resulting URL is unaffected: Next mounts
 * the route fresh and this component re-derives its state from the chatId prop exactly as a direct
 * visit would.
 *
 * A reopened local thread's own messages come from useLocalThreadSnapshot (read once, hydration-
 * safe); everything sent THIS session lives in `pendingTurns`, appended only from event handlers —
 * never from an effect's synchronous body (this repo's lint config flags that pattern; the
 * project's own established fix, confirmed in shell's use-sidebar-collapsed.ts/local-threads.ts, is
 * useSyncExternalStore, not useEffect+setState).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiFetchJson } from "@/lib/api";
import { useIsOffline } from "@/lib/api/offline-status";
import { canonicalErrorMessage } from "@/lib/copy/errors";
import { useAnnounce } from "@/components/layout-primitives/live-region";
import { useSession, sessionSignInAvailable } from "@/lib/session/use-session";
import { DisclaimerLine } from "@/components/brand/disclaimer-line";
import { ErrorState } from "@/components/feedback/error-state";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { SignInNudge } from "@/components/upload";
import { appendMessage, createEmptyThread, type GuestMessage, type GuestThread } from "@/lib/guest-thread-store";
import {
  chunkForVerifyBatch,
  deleteLocalThreadAfterImport,
  isLocalThreadId,
  isWithinImportCaps,
  loadLocalThread,
  mintLocalThreadId,
  saveLocalThread,
  toAskHistory,
  toGuestThreadCitation,
  UNLINKED_SOURCE_DOCUMENT_ID,
} from "@/lib/guest-threads";
import { MAX_CONTEXT_DOCUMENTS, type AskCitationOutput, type AskMessageOutput, type MessagesOutput, type ThreadMessageOutput } from "@/shared/contracts/threads";
import type { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import { SampleOpenOutput } from "@/shared/contracts/samples";
import type { SseFrame } from "@/lib/sse";
import { askGuestStream, askThreadStream, createThread, fetchDocument, fetchThreadMessages, verifyBatch } from "./api";
import { consumeAskStream } from "./stream";
import { deriveTitle } from "./title";
import { orderedSamples } from "./catalogue";
import { starterPromptsFor } from "./starter-prompts-copy";
import { SituationChips } from "./situation-chips";
import { StarterPrompts } from "./starter-prompts";
import { SampleCards, type SampleCardError } from "./sample-cards";
import { useSituation } from "./use-situation";
import { useLocalThreadSnapshot } from "./use-local-thread-snapshot";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import type { DisplayCitation, DisplayMessage, TurnError } from "./types";

export interface ChatScreenProps {
  /** null for /chat (home); a local-<uuid> or a real server thread id for /chat/[chatId]. */
  chatId: string | null;
}

const DOCUMENT_NOT_READY_MESSAGE = "One of the documents attached to this chat isn't ready yet. Try again in a moment.";
const GROUNDING_TOO_LONG_MESSAGE =
  "One of the documents attached to this chat is too long to use as context. Try asking about it from its own workspace instead, or ask a narrower question.";
const ATTACH_FAILED_MESSAGE = "That document couldn't be attached.";
const SAVE_TOO_LONG_MESSAGE =
  "This chat has grown too long to save as one conversation. Try saving from a more recent point, or start a new chat for further questions.";
const ATTACH_DISABLED_ON_SAVED_THREAD = "This chat is already saved. Start a new chat to attach another document.";
/** The chip label an attachment falls back to when its own GET /api/documents/:id fails (an expired guest document, most often) — the id is still known and still attached, so the chip stays removable even without a real title. */
const NEUTRAL_ATTACHMENT_LABEL = "Attached document";

interface AttachedDoc {
  id: string;
  label: string;
}

interface RetryBuffer {
  query: string;
  /** The pendingTurns entry the failed attempt appended, if any — removed before resubmitting so a retry never leaves two identical user bubbles behind. */
  failedUserMessageId?: string;
}

function toAttachedDoc(document: DocumentWithFindingsOutput): AttachedDoc {
  return { id: document.document.id, label: document.document.title || document.document.filename };
}

function newDisplayMessage(
  partial: Omit<DisplayMessage, "citations" | "modelUsed" | "redirect"> & Partial<Pick<DisplayMessage, "citations" | "modelUsed" | "redirect">>,
): DisplayMessage {
  return { citations: [], modelUsed: null, redirect: false, ...partial };
}

function guestMessageToDisplay(message: GuestMessage): DisplayMessage {
  return newDisplayMessage({
    id: message.id,
    role: message.role,
    content: message.content,
    mode: message.mode,
    createdAtMs: message.createdAtMs,
    citations: message.citations.map(
      (citation): DisplayCitation => ({ kind: "pending", sourceDocumentId: citation.sourceDocumentId, preview: citation.quoteText }),
    ),
  });
}

function wireMessageToDisplay(message: ThreadMessageOutput): DisplayMessage {
  if (message.role === "user") {
    return newDisplayMessage({ id: message.id, role: "user", content: message.content, mode: null, createdAtMs: Date.parse(message.createdAt) });
  }
  const createdAtMs = message.createdAt ? Date.parse(message.createdAt) : Date.now();
  if (message.mode === "grounded") {
    return newDisplayMessage({
      id: message.id ?? crypto.randomUUID(),
      role: "assistant",
      content: message.content,
      mode: "grounded",
      modelUsed: message.modelUsed,
      createdAtMs,
      citations: message.citations.map((citation): DisplayCitation => ({ kind: "resolved", citation })),
    });
  }
  return newDisplayMessage({
    id: message.id ?? crypto.randomUUID(),
    role: "assistant",
    content: message.content,
    mode: "general",
    modelUsed: message.modelUsed,
    redirect: message.redirect,
    createdAtMs,
  });
}

function askMessageOutputToDisplay(id: string, message: AskMessageOutput): DisplayMessage {
  if (message.mode === "grounded") {
    return newDisplayMessage({
      id,
      role: "assistant",
      content: message.content,
      mode: "grounded",
      modelUsed: message.modelUsed,
      createdAtMs: Date.now(),
      citations: message.citations.map((citation): DisplayCitation => ({ kind: "resolved", citation })),
    });
  }
  return newDisplayMessage({
    id,
    role: "assistant",
    content: message.content,
    mode: "general",
    modelUsed: message.modelUsed,
    redirect: message.redirect,
    createdAtMs: Date.now(),
  });
}

function reasonComposerCopy(reason: string | undefined): string | null {
  if (reason === "document_not_ready") return DOCUMENT_NOT_READY_MESSAGE;
  if (reason === "grounding_too_long") return GROUNDING_TOO_LONG_MESSAGE;
  return null;
}

function applyCitationOverrides(thread: GuestThread, overrides: Record<string, DisplayCitation>): DisplayMessage[] {
  return thread.messages.map((message) => {
    const display = guestMessageToDisplay(message);
    return { ...display, citations: display.citations.map((citation, i) => overrides[`${message.id}#${i}`] ?? citation) };
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

interface KeyedCitation {
  key: string;
  documentId: string;
  quote: string;
}

/**
 * Runs verify-batch for one chunk and turns the response straight into the overrides map a chunk's
 * citations resolve to — shared by both the reopen pass's first attempt and a failed citation's own
 * Retry, so a retry is a real verify() round trip against the live document, never a client-guessed
 * status. `onRetry` is only ever attached to the failure branch; a caller that reruns this same
 * function is exactly what makes Retry real rather than a dead button. Returns null for an aborted
 * request — a real unmount or a superseded id swap, nothing left to render.
 */
async function verifyChunk(
  chunk: KeyedCitation[],
  signal: AbortSignal | undefined,
  onRetry: () => void,
): Promise<Record<string, DisplayCitation> | null> {
  try {
    const results = await verifyBatch(
      chunk.map((entry) => ({ documentId: entry.documentId, quote: entry.quote })),
      signal,
    );
    const overrides: Record<string, DisplayCitation> = {};
    chunk.forEach((entry, i) => {
      const sourceDocumentId = entry.documentId === UNLINKED_SOURCE_DOCUMENT_ID ? null : entry.documentId;
      const citation: AskCitationOutput = { id: null, sourceDocumentId, inputMode: null, verification: results[i] };
      overrides[entry.key] = { kind: "resolved", citation };
    });
    return overrides;
  } catch (err) {
    if (isAbortError(err)) return null;
    const overrides: Record<string, DisplayCitation> = {};
    chunk.forEach((entry) => {
      overrides[entry.key] = { kind: "failed", sourceDocumentId: entry.documentId, preview: entry.quote, onRetry };
    });
    return overrides;
  }
}

export function ChatScreen({ chatId }: ChatScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const offline = useIsOffline();
  const session = useSession();
  const signInAvailable = sessionSignInAvailable(session);
  const isSignedIn = session.data?.kind === "user";

  const [activeChatId, setActiveChatId] = useState<string | null>(chatId);
  const [mode, setMode] = useState<"home" | "thread">(chatId ? "thread" : "home");
  const [pendingTurns, setPendingTurns] = useState<DisplayMessage[]>([]);
  const [citationOverrides, setCitationOverrides] = useState<Record<string, DisplayCitation>>({});
  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<AttachedDoc[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const [composerInlineError, setComposerInlineError] = useState<string | null>(null);
  const [retryBuffer, setRetryBuffer] = useState<RetryBuffer | null>(null);
  const [attachFailedNotice, setAttachFailedNotice] = useState(false);
  const [attachDisabledReason, setAttachDisabledReason] = useState<string | null>(
    chatId && !isLocalThreadId(chatId) ? ATTACH_DISABLED_ON_SAVED_THREAD : null,
  );
  const [secondUploadNudge, setSecondUploadNudge] = useState(false);
  const [, setUploadCount] = useState(0);
  const [saveNudge, setSaveNudge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [situation, setSituation] = useSituation();
  const [openingSampleId, setOpeningSampleId] = useState<string | null>(null);
  const [sampleErrors, setSampleErrors] = useState<Partial<Record<string, SampleCardError>>>({});
  const attachHandledRef = useRef(false);

  // Every fetch/stream this screen starts shares one controller, aborted only on a real unmount
  // (a route change away from /chat/* entirely) — never on the internal id swaps above, which
  // never unmount this component in the first place. The controller is created INSIDE the effect,
  // not at render time: `next dev`'s Strict Mode runs mount -> cleanup -> mount once on every fresh
  // mount, and a cleanup that aborts whatever the ref currently holds (rather than the specific
  // controller ITS OWN mount created) would abort the ref permanently after the first of those two
  // mounts, leaving every real request this component ever makes pre-aborted.
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return () => controller.abort();
  }, []);

  // "Save this chat" proactively disables once a local thread would exceed the server's own import
  // caps — recomputed from the actual saved thread after every turn, not merely at load time.
  const [withinCaps, setWithinCaps] = useState(true);
  const [threadTitle, setThreadTitle] = useState("New chat");
  const [seededFromId, setSeededFromId] = useState<string | null>(null);

  const isRealServerThread = activeChatId !== null && !isLocalThreadId(activeChatId);
  const localId = activeChatId && isLocalThreadId(activeChatId) ? activeChatId : null;
  const localSnapshot = useLocalThreadSnapshot(localId);
  const currentLocalThread = localSnapshot.status === "loaded" ? localSnapshot.thread : null;

  // React's own "adjust state when an input changed" pattern (see RetryAfterNotice's identical
  // technique) — several setState calls in one guarded block during render, never in an effect.
  if (currentLocalThread && seededFromId !== localId) {
    setSeededFromId(localId);
    setWithinCaps(isWithinImportCaps(currentLocalThread));
    setThreadTitle(currentLocalThread.title);
  }

  const serverMessages = useQuery({
    queryKey: ["threads", "messages", activeChatId],
    queryFn: () => fetchThreadMessages(activeChatId as string),
    enabled: isRealServerThread,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const notFound =
    (localId !== null && localSnapshot.status === "not-found") ||
    (isRealServerThread && serverMessages.isError && serverMessages.error instanceof ApiError && serverMessages.error.code === "NOT_FOUND");

  const baseMessages: DisplayMessage[] = currentLocalThread
    ? applyCitationOverrides(currentLocalThread, citationOverrides)
    : isRealServerThread && serverMessages.data
      ? serverMessages.data.messages.map(wireMessageToDisplay)
      : [];
  const messages = [...baseMessages, ...pendingTurns];

  // The reopen re-verify pass — sequential, chunked verify-batch, never touching the badge until it
  // resolves. Runs once the local snapshot is available; its own setState calls all sit inside an
  // async continuation (after an await), never synchronously in the effect body. A chunk that fails
  // gets a real, working Retry: clicking it flips the chunk back to "pending" (so the button can't
  // double-fire) and reruns this exact same verify-batch call, reading the abort signal fresh at
  // click time rather than the one this effect captured when it first ran.
  useEffect(() => {
    if (!currentLocalThread) return;
    const keyed: KeyedCitation[] = [];
    currentLocalThread.messages.forEach((message) => {
      message.citations.forEach((citation, citationIndex) => {
        keyed.push({ key: `${message.id}#${citationIndex}`, documentId: citation.sourceDocumentId, quote: citation.quoteText });
      });
    });
    if (keyed.length === 0) return;

    let cancelled = false;

    function retryChunk(chunk: KeyedCitation[]): void {
      setCitationOverrides((prev) => {
        const next = { ...prev };
        chunk.forEach((entry) => {
          next[entry.key] = { kind: "pending", sourceDocumentId: entry.documentId, preview: entry.quote };
        });
        return next;
      });
      void runChunk(chunk);
    }

    async function runChunk(chunk: KeyedCitation[]): Promise<void> {
      if (cancelled) return;
      const overrides = await verifyChunk(chunk, abortControllerRef.current?.signal, () => retryChunk(chunk));
      if (cancelled || overrides === null) return;
      setCitationOverrides((prev) => ({ ...prev, ...overrides }));
    }

    void (async () => {
      for (const chunk of chunkForVerifyBatch(keyed)) {
        if (cancelled) return;
        await runChunk(chunk);
      }
    })();
    return () => {
      cancelled = true;
    };
    // currentLocalThread (not just localId) is the real dependency: useLocalThreadSnapshot resolves
    // in two passes for hydration safety (a "loading" server snapshot, then the real one) — an
    // effect keyed on localId alone would capture the FIRST pass's null value in its closure and
    // never re-run once the real snapshot arrives, since localId itself never changes between the
    // two passes. The snapshot's own object identity is stable once loaded (cached per id), so this
    // never re-runs on an unrelated render.
  }, [currentLocalThread]);

  // Attachment labels for a reopened local thread's own documentIds — the snapshot carries only
  // ids; each one resolves through its own bare fetchDocument call below, straight into this
  // component's local `attachments` state (never a shared query cache). Same currentLocalThread
  // dependency reasoning as the reverify pass above.
  useEffect(() => {
    if (!currentLocalThread) return;
    for (const documentId of currentLocalThread.documentIds) {
      void fetchDocument(documentId)
        .then((document) => {
          setAttachments((prev) => (prev.some((a) => a.id === documentId) ? prev : [...prev, toAttachedDoc(document)]));
        })
        .catch(() => {
          // An expired/foreign guest document — still attached, still removable, just without a real title.
          setAttachments((prev) => (prev.some((a) => a.id === documentId) ? prev : [...prev, { id: documentId, label: NEUTRAL_ATTACHMENT_LABEL }]));
        });
    }
  }, [currentLocalThread]);

  // ?attach=<documentId>: read once, cleared via replaceState either way. Only meaningful on a
  // fresh /chat home mount (chatId prop null) — the one place this param is produced.
  useEffect(() => {
    if (chatId !== null || attachHandledRef.current) return;
    attachHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const documentId = params.get("attach");
    if (!documentId) return;

    void fetchDocument(documentId)
      .then((document) => {
        if (document.document.processingStatus !== "ready") {
          setAttachFailedNotice(true);
          return;
        }
        setAttachments((prev) => (prev.length >= MAX_CONTEXT_DOCUMENTS ? prev : [...prev, toAttachedDoc(document)]));
      })
      .catch(() => setAttachFailedNotice(true))
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("attach");
        window.history.replaceState(null, "", url.pathname + url.search);
      });
  }, [chatId]);

  // The sidebar's "New chat" link (or any other real navigation) landing back on the exact "/chat"
  // pathname is the one direction the internal id swap above never produces on its own — that swap
  // only ever moves /chat -> /chat/<id> via replaceState, never the reverse. A ref (not a bare
  // `pathname === "/chat"` check) means this only fires on a genuine backward transition, once,
  // rather than on every render where the two states happen to already match.
  const previousPathnameRef = useRef(pathname);
  useEffect(() => {
    const previousPathname = previousPathnameRef.current;
    previousPathnameRef.current = pathname;
    if (previousPathname === pathname || pathname !== "/chat" || previousPathname === "/chat") return;

    setActiveChatId(null);
    setMode("home");
    setPendingTurns([]);
    setCitationOverrides({});
    setInputValue("");
    setAttachments([]);
    setStreamingText(null);
    setSending(false);
    setTurnError(null);
    setComposerInlineError(null);
    setRetryBuffer(null);
    setAttachFailedNotice(false);
    setAttachDisabledReason(null);
    setSecondUploadNudge(false);
    setUploadCount(0);
    setSaveNudge(false);
    setSaving(false);
    setOpeningSampleId(null);
    setSampleErrors({});
    setSeededFromId(null);
    setThreadTitle("New chat");
    setWithinCaps(true);
    attachHandledRef.current = false;
  }, [pathname]);

  function addAttachment(documentId: string, doc: AttachedDoc): void {
    setAttachments((prev) => (prev.length >= MAX_CONTEXT_DOCUMENTS ? prev : [...prev, doc]));
    if (localId) saveLocalThread(localId, { ...loadLocalThread(localId), documentIds: [...loadLocalThread(localId).documentIds, documentId] });
    setUploadCount((prev) => {
      const next = prev + 1;
      if (next === 2 && signInAvailable) setSecondUploadNudge(true);
      return next;
    });
  }

  function handleAttached(documentId: string) {
    void fetchDocument(documentId)
      .then((document) => addAttachment(documentId, toAttachedDoc(document)))
      .catch(() => addAttachment(documentId, { id: documentId, label: NEUTRAL_ATTACHMENT_LABEL }));
  }

  function handleRemoveAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    if (localId) {
      const thread = loadLocalThread(localId);
      saveLocalThread(localId, { ...thread, documentIds: thread.documentIds.filter((d) => d !== id) });
    }
  }

  function persistGuestTurn(localThreadId: string, userContent: string, assistantId: string, message: AskMessageOutput): void {
    let thread = loadLocalThread(localThreadId);
    thread = appendMessage(thread, { id: crypto.randomUUID(), role: "user", content: userContent, mode: null, citations: [], createdAtMs: Date.now() });
    const citations = message.mode === "grounded" ? message.citations.map(toGuestThreadCitation) : [];
    thread = appendMessage(thread, { id: assistantId, role: "assistant", content: message.content, mode: message.mode, citations, createdAtMs: Date.now() });
    const { evictedIds } = saveLocalThread(localThreadId, thread);
    if (evictedIds.length > 0) toast("Removed your oldest local chat to make room.");
    setWithinCaps(isWithinImportCaps(thread));
  }

  /** A saved thread's turn writes straight into its own message-list cache (never a refetch) and folds the just-shown pendingTurns entries away, since the cache is now the single source for them. */
  function foldIntoServerCache(threadId: string, userContent: string, message: AskMessageOutput): void {
    const userWire = { id: crypto.randomUUID(), role: "user" as const, content: userContent, createdAt: new Date().toISOString() };
    queryClient.setQueryData(["threads", "messages", threadId], (prev: MessagesOutput | undefined) => ({
      messages: [...(prev?.messages ?? []), userWire, message],
    }));
    setPendingTurns([]);
  }

  async function runTurn(
    query: string,
    framesPromise: Promise<AsyncGenerator<SseFrame>>,
    onFinal: (assistantId: string, message: AskMessageOutput) => void,
  ): Promise<void> {
    const frames = await framesPromise; // throws before this resolves for any pre-stream failure
    const userId = crypto.randomUUID();
    setPendingTurns((prev) => [...prev, newDisplayMessage({ id: userId, role: "user", content: query, mode: null, createdAtMs: Date.now() })]);
    setStreamingText("");
    let outcome;
    try {
      outcome = await consumeAskStream(frames, { onToken: (text) => setStreamingText((prev) => (prev ?? "") + text) });
    } catch (err) {
      // A genuine mid-read failure (the connection dropped while iterating the SSE body, never a
      // well-formed `event: error` frame — consumeAskStream turns THAT into a returned outcome, not
      // a throw). streamingText must still clear here: left at "" rather than null, the composer's
      // `streamingText !== null` disable check would never lift again, for a real unmount included —
      // an aborted read has nothing left to update safely, but the flag still needs resetting first.
      setStreamingText(null);
      if (isAbortError(err)) return;
      setTurnError({ code: "INTERNAL_ERROR", message: canonicalErrorMessage("INTERNAL_ERROR") });
      setRetryBuffer({ query, failedUserMessageId: userId });
      setSending(false);
      return;
    }
    setStreamingText(null);
    if (outcome.type === "error") {
      setTurnError({ code: outcome.error.code, message: outcome.error.message, retryAfterSeconds: outcome.error.retryAfterSeconds });
      setRetryBuffer({ query, failedUserMessageId: userId });
      setSending(false);
      return;
    }
    const assistantId = crypto.randomUUID();
    setPendingTurns((prev) => [...prev, askMessageOutputToDisplay(assistantId, outcome.message)]);
    onFinal(assistantId, outcome.message);
    announce("An answer has arrived.", "polite");
    setSending(false);
  }

  async function handleSubmit(queryOverride?: string): Promise<void> {
    const query = (queryOverride ?? inputValue).trim();
    if (!query || sending || offline) return;
    setTurnError(null);
    setComposerInlineError(null);
    setSending(true);
    const attachedIds = attachments.map((a) => a.id);
    const signal = abortControllerRef.current?.signal;

    try {
      if (mode === "home") {
        if (isSignedIn) {
          const created = await createThread({ title: deriveTitle(query), documentIds: attachedIds.length ? attachedIds : undefined });
          queryClient.setQueryData(["threads", "messages", created.thread.id], { messages: [] });
          setActiveChatId(created.thread.id);
          window.history.replaceState(null, "", `/chat/${created.thread.id}`);
          setMode("thread");
          setAttachDisabledReason(ATTACH_DISABLED_ON_SAVED_THREAD);
          setThreadTitle(deriveTitle(query));
          setInputValue("");
          await runTurn(query, askThreadStream(created.thread.id, query, signal), (_assistantId, message) =>
            foldIntoServerCache(created.thread.id, query, message),
          );
        } else {
          const id = mintLocalThreadId();
          const thread: GuestThread = { ...createEmptyThread(id, deriveTitle(query)), documentIds: attachedIds };
          saveLocalThread(id, thread);
          setActiveChatId(id);
          window.history.replaceState(null, "", `/chat/${id}`);
          setMode("thread");
          setThreadTitle(thread.title);
          setInputValue("");
          const history = toAskHistory(thread);
          await runTurn(
            query,
            askGuestStream({ query, documentIds: attachedIds.length ? attachedIds : undefined, history: history.length ? history : undefined }, signal),
            (assistantId, message) => persistGuestTurn(id, query, assistantId, message),
          );
        }
      } else {
        const id = activeChatId as string;
        setInputValue("");
        if (isLocalThreadId(id)) {
          const thread = loadLocalThread(id);
          const history = toAskHistory(thread);
          await runTurn(
            query,
            askGuestStream({ query, documentIds: thread.documentIds.length ? thread.documentIds : undefined, history: history.length ? history : undefined }, signal),
            (assistantId, message) => persistGuestTurn(id, query, assistantId, message),
          );
        } else {
          await runTurn(query, askThreadStream(id, query, signal), (_assistantId, message) => foldIntoServerCache(id, query, message));
        }
      }
    } catch (err) {
      setSending(false);
      if (isAbortError(err)) return;
      if (err instanceof ApiError) {
        const reasonCopy = reasonComposerCopy(err.reason);
        if (reasonCopy) {
          setComposerInlineError(reasonCopy);
          setInputValue(query);
          return;
        }
        setTurnError({ code: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds });
        setRetryBuffer({ query });
        return;
      }
      setTurnError({ code: "INTERNAL_ERROR", message: canonicalErrorMessage("INTERNAL_ERROR") });
      setRetryBuffer({ query });
    }
  }

  function handleRetry(): void {
    if (!retryBuffer) return;
    const { query, failedUserMessageId } = retryBuffer;
    if (failedUserMessageId) setPendingTurns((prev) => prev.filter((m) => m.id !== failedUserMessageId));
    setRetryBuffer(null);
    setTurnError(null);
    void handleSubmit(query);
  }

  async function handleSaveThisChat(): Promise<void> {
    if (!localId) return;
    if (!isSignedIn) {
      setSaveNudge(true);
      return;
    }
    const thread = loadLocalThread(localId);
    setSaving(true);
    try {
      const importedMessages = thread.messages.map((message) => ({
        role: message.role,
        content: message.content,
        mode: message.mode,
        citations: message.citations.length
          ? message.citations.map((citation) => ({ quoteText: citation.quoteText, sourceDocumentId: citation.sourceDocumentId }))
          : undefined,
      }));
      const created = await createThread({
        title: thread.title,
        documentIds: thread.documentIds.length ? thread.documentIds : undefined,
        importedMessages,
      });
      deleteLocalThreadAfterImport(localId);
      const savedId = created.thread.id;
      queryClient.setQueryData(["threads", "messages", savedId], { messages: created.messages });
      setActiveChatId(savedId);
      window.history.replaceState(null, "", `/chat/${savedId}`);
      setAttachDisabledReason(ATTACH_DISABLED_ON_SAVED_THREAD);
      setPendingTurns([]);
      toast.success("Chat saved.");
      announce("Chat saved.", "polite");
    } catch (err) {
      if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
        toast.error(SAVE_TOO_LONG_MESSAGE);
      } else {
        toast.error("Couldn't save this chat.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenSample(sampleId: string): Promise<void> {
    setOpeningSampleId(sampleId);
    setSampleErrors((prev) => ({ ...prev, [sampleId]: undefined }));
    try {
      const body = await apiFetchJson<unknown>(`/api/samples/${encodeURIComponent(sampleId)}/open`, { method: "POST" });
      const parsed = SampleOpenOutput.parse(body);
      router.push(`/documents/${parsed.documentId}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setSampleErrors((prev) => ({ ...prev, [sampleId]: { code: err.code, retryAfterSeconds: err.retryAfterSeconds } }));
      } else {
        setSampleErrors((prev) => ({ ...prev, [sampleId]: { code: "INTERNAL_ERROR" } }));
      }
    } finally {
      setOpeningSampleId(null);
    }
  }

  const canSaveThisChat = localId !== null && messages.length > 0 && signInAvailable;

  if (notFound) {
    return (
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center p-6">
        <ErrorState code="NOT_FOUND" />
      </div>
    );
  }

  if (mode === "home") {
    const samples = orderedSamples(situation);
    const prompts = starterPromptsFor(situation);
    return (
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-6 p-6">
        <h1 className="text-center font-display text-2xl font-medium text-foreground">What&apos;s in your document?</h1>
        <SituationChips value={situation} onChange={setSituation} />
        <Composer
          value={inputValue}
          onChange={setInputValue}
          onSubmit={() => void handleSubmit()}
          disabled={sending}
          offline={offline}
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          onAttached={handleAttached}
          isSignedIn={isSignedIn}
          guestTtlHours={session.data?.guestTtlHours}
          inlineError={composerInlineError}
        />
        <DisclaimerLine variant="composer" />
        {attachFailedNotice && <InlineNotice tone="warning">{ATTACH_FAILED_MESSAGE}</InlineNotice>}
        {secondUploadNudge && signInAvailable && <SignInNudge context="second_upload" onSignIn={() => router.push("/sign-in")} />}
        <StarterPrompts prompts={prompts} onSelect={(prompt) => setInputValue(prompt)} />
        <SampleCards samples={samples} onOpen={(id) => void handleOpenSample(id)} openingSampleId={openingSampleId} errors={sampleErrors} disabled={offline} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col p-4">
      <h1 className="sr-only">{threadTitle}</h1>
      {canSaveThisChat && (
        <button
          type="button"
          onClick={() => void handleSaveThisChat()}
          disabled={saving || !withinCaps}
          className="mb-2 inline-flex min-h-11 items-center self-start text-sm font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
        >
          Save this chat
        </button>
      )}
      {!withinCaps && canSaveThisChat && <p className="mb-2 text-xs text-muted-foreground">{SAVE_TOO_LONG_MESSAGE}</p>}
      {saveNudge && <SignInNudge context="save" onSignIn={() => router.push("/sign-in")} />}

      {serverMessages.isLoading && isRealServerThread ? (
        <div className="flex flex-1 flex-col gap-3 py-4" aria-hidden="true">
          <div className="h-16 w-2/3 animate-pulse rounded-2xl bg-muted" />
          <div className="h-16 w-3/4 animate-pulse self-end rounded-2xl bg-muted" />
        </div>
      ) : (
        <MessageList messages={messages} streamingText={streamingText} error={turnError} onRetryError={turnError ? handleRetry : undefined} />
      )}

      <div className="sticky bottom-0 mt-2 bg-background pt-2">
        <Composer
          value={inputValue}
          onChange={setInputValue}
          onSubmit={() => void handleSubmit()}
          disabled={sending || streamingText !== null}
          offline={offline}
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          onAttached={handleAttached}
          attachDisabledReason={attachDisabledReason}
          isSignedIn={isSignedIn}
          guestTtlHours={session.data?.guestTtlHours}
          inlineError={composerInlineError}
        />
        <DisclaimerLine variant="composer" />
      </div>
      {attachFailedNotice && <InlineNotice tone="warning">{ATTACH_FAILED_MESSAGE}</InlineNotice>}
      {secondUploadNudge && signInAvailable && <SignInNudge context="second_upload" onSignIn={() => router.push("/sign-in")} />}
    </div>
  );
}
