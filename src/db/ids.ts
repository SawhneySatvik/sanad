import { uuidv7 } from "uuidv7";

/**
 * The id generator for every app-supplied primary key: a time-ordered UUIDv7, required by `messages`'
 * CHECK constraint and by listRecentMessages's tie-break, which needs ids to stay monotonic even
 * across same-millisecond calls.
 */
export function newId(): string {
  return uuidv7();
}
