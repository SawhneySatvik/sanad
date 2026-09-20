/**
 * Server-sent events for a route whose service returns an async iterable. The first event is read
 * before anything is sent: a typed error event means no content was produced, so the response is
 * that code's real HTTP status with a JSON error body, never a 200 carrying an error. Only a
 * non-error first event commits 200 + text/event-stream; a later error becomes one `event: error`
 * frame and ends the stream. The iterator always closes when the stream stops early.
 */

import type { z } from "zod";
import { APP_ERROR_CODES, AppError, ERROR_REASONS, safeMessageFor, type AppErrorCode, type ErrorReason } from "@/server/core/errors";
import { CORRELATION_ID_HEADER, logRequestError, mapError, type RequestLogContext } from "./errors";
import { toWire } from "./wire";

const encoder = new TextEncoder();
const EVENT_NAME_RE = /^[A-Za-z_]+$/;

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (APP_ERROR_CODES as readonly unknown[]).includes(value);
}

function isErrorReason(value: unknown): value is ErrorReason {
  return (ERROR_REASONS as readonly unknown[]).includes(value);
}

// The error an `{ type: "error" }` event stands for, or null for any other event. Rebuilt with the
// event's own reason/retryAfterSeconds (OrchestratorEvent's error variant carries both) so the
// pre-stream path — this AppError is thrown and mapped the normal way — matches the mid-stream
// errorFrame() path exactly.
function errorOf(event: unknown): Error | null {
  if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "error") return null;
  const code = "code" in event ? event.code : undefined;
  if (!isAppErrorCode(code)) return new Error("error event without a known code");
  const reason = "reason" in event && isErrorReason(event.reason) ? event.reason : undefined;
  const retryAfterSeconds = "retryAfterSeconds" in event && typeof event.retryAfterSeconds === "number" ? event.retryAfterSeconds : undefined;
  return new AppError(code, safeMessageFor(code), { reason, retryAfterSeconds });
}

function eventFrame(schema: z.ZodType, event: unknown): Uint8Array {
  const data = toWire(schema, event);
  const type = typeof data === "object" && data !== null && "type" in data ? data.type : undefined;
  const name = typeof type === "string" && EVENT_NAME_RE.test(type) ? type : "message";
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorFrame(error: unknown, log: RequestLogContext): Uint8Array {
  const mapped = mapError(error);
  logRequestError(log, mapped.status, error);
  return encoder.encode(`event: error\ndata: ${JSON.stringify(mapped.body)}\n\n`);
}

/**
 * Turns a service's async event iterable into an SSE Response, reading its first event to decide
 * the HTTP status before any header is sent.
 * @throws whatever the first event fails with, for the route layer to map — the response never commits.
 */
export async function eventStreamResponse(
  events: AsyncIterable<unknown>,
  eventSchema: z.ZodType,
  log: RequestLogContext,
): Promise<Response> {
  const iterator = events[Symbol.asyncIterator]();
  let firstFrame: Uint8Array;
  try {
    const first = await iterator.next();
    if (first.done) throw new Error("event stream ended before its first event");
    const error = errorOf(first.value);
    if (error) throw error;
    firstFrame = eventFrame(eventSchema, first.value);
  } catch (error) {
    await iterator.return?.();
    throw error;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstFrame);
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const error = errorOf(next.value);
        if (error) throw error;
        controller.enqueue(eventFrame(eventSchema, next.value));
      } catch (error) {
        controller.enqueue(errorFrame(error, log));
        controller.close();
        await iterator.return?.();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      // A mid-stream error frame is logged under this id.
      [CORRELATION_ID_HEADER]: log.correlationId,
    },
  });
}
