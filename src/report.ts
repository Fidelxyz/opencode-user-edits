import type { Baseline, SnapshotStore, Worktree } from "./snapshot.ts";

export const MAX_PATCH_LINES = 50;
export const MAX_PATCH_CHARS = 4000;
export const MAX_FILE_LINES = 50;

/** HEAD commits before and after the change. */
export interface HeadChange {
  readonly from: Baseline["head"];
  readonly to: Baseline["head"];
}

/** JSON value describing the changes made outside the agent, persisted in prompt metadata. */
export type UserEdits = {
  readonly root: string;
  readonly headChange?: HeadChange;
} & (
  | { readonly kind: "patch"; readonly patch: string }
  | { readonly kind: "files"; readonly files: readonly string[]; readonly omitted: number }
  | { readonly kind: "head" }
);

export async function describeUserEdits(
  store: Pick<SnapshotStore, "changes" | "patch">,
  worktree: Worktree,
  from: Baseline,
  to: Baseline,
): Promise<UserEdits | undefined> {
  const headChange = from.head === to.head ? undefined : { from: from.head, to: to.head };
  const base = { root: worktree.root, ...(headChange && { headChange }) };

  const changes = await store.changes(worktree, from.tree, to.tree);
  if (changes.length === 0) return headChange ? { ...base, kind: "head" } : undefined;

  // skip the costly diff when the patch cannot fit.
  const patch =
    changes.length * 2 > MAX_PATCH_LINES // Each file takes at least two patch lines.
      ? undefined
      : await store.patch(worktree, from.tree, to.tree, MAX_PATCH_CHARS);
  if (patch !== undefined && patch.split("\n").length - 1 <= MAX_PATCH_LINES) {
    return { ...base, kind: "patch", patch };
  }

  return {
    ...base,
    kind: "files",
    files: changes.slice(0, MAX_FILE_LINES),
    omitted: Math.max(0, changes.length - MAX_FILE_LINES),
  };
}
