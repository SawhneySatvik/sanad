/**
 * The rows of a raw `db.execute(sql…)` result. Drizzle resolves it to `{ rows }` on PGlite but to
 * the row array itself on postgres.js, so reading `.rows` alone works in development and tests and
 * then fails on the hosted database.
 */
export function executeRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}
