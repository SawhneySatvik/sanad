/**
 * /projects/[id]'s own "Remove from project" ConfirmDeleteDialog copy — distinct from /library's
 * delete copy (this dialog never deletes anything). A draft's own `N` is computed client-side by
 * counting how many of this project's already-fetched draft rows share the same chain (follow
 * `parentDraftId`), since `ProjectDraftSummaryOutput` carries no chain-level `revisionCount`.
 */

export function unassignDescription(title: string): string {
  return `Remove '${title}' from this project? It stays in your library.`;
}

export function unassignDraftDescription(chainCount: number): string {
  return chainCount === 1
    ? "Remove this draft from the project? It stays in your library."
    : `Remove all ${chainCount} revisions of this draft from the project? They stay in your library.`;
}

/** Counts how many of this project's already-loaded draft rows share the given draft's chain root. */
export function countDraftChainInProject(
  drafts: { id: string; parentDraftId: string | null }[],
  targetId: string,
): number {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  function rootOf(id: string): string {
    let current = byId.get(id);
    let currentId = id;
    while (current?.parentDraftId && byId.has(current.parentDraftId)) {
      currentId = current.parentDraftId;
      current = byId.get(currentId);
    }
    return currentId;
  }
  const targetRoot = rootOf(targetId);
  return drafts.filter((d) => rootOf(d.id) === targetRoot).length;
}
