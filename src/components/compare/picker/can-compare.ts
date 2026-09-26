/**
 * "Compare" is enabled iff both slots hold a document and they're different ones — a pure function
 * of (slotA, slotB), never a client-side focus trap.
 */
export function canCompare(slotA: string | null, slotB: string | null): boolean {
  return slotA !== null && slotB !== null && slotA !== slotB;
}
