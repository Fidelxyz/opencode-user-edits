import { describe, expect, it } from "vitest";
import { describeUserEdits } from "../src/report.ts";
import type { SnapshotStore, Worktree } from "../src/snapshot.ts";

const HEAD = "a".repeat(40);
const WORKTREE: Worktree = { root: "/repo", commonDir: "/repo/.git" };

function fakeStore(changes: readonly string[], patch: string | undefined): Pick<SnapshotStore, "changes" | "patch"> {
  return {
    changes: async () => changes,
    patch: async () => patch,
  };
}

function modified(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `M\tfile-${index}.txt`);
}

function describeWith(changes: readonly string[], patch: string | undefined, head = HEAD) {
  return describeUserEdits(
    fakeStore(changes, patch),
    WORKTREE,
    { tree: "tree-a", head: HEAD },
    { tree: "tree-b", head },
  );
}

describe("describeUserEdits", () => {
  it("returns undefined when nothing changed", async () => {
    expect(await describeWith([], "")).toBeUndefined();
  });

  it("reports a HEAD move when the trees are identical", async () => {
    const moved = "b".repeat(40);

    expect(await describeWith([], "", moved)).toEqual({
      kind: "head",
      root: "/repo",
      headChange: { from: HEAD, to: moved },
    });
  });

  it("returns the patch within the line and char limits", async () => {
    const text = "diff --git a/a.txt b/a.txt\n-old\n+new\n";

    const edits = await describeWith(modified(1), text);

    expect(edits).toMatchObject({ kind: "patch", root: "/repo" });
    expect(edits?.kind === "patch" && edits.patch).toContain("+new");
  });

  it("falls back to the file list when the patch exceeds the line limit", async () => {
    const text = Array.from({ length: 60 }, (_, index) => `+line ${index}`).join("\n");

    expect(await describeWith(modified(1), text)).toEqual({
      kind: "files",
      root: "/repo",
      files: modified(1),
      omitted: 0,
    });
  });

  it("falls back to the file list when the patch is unavailable", async () => {
    expect(await describeWith(modified(2), undefined)).toEqual({
      kind: "files",
      root: "/repo",
      files: modified(2),
      omitted: 0,
    });
  });

  it("caps the file list and counts omitted files", async () => {
    expect(await describeWith(modified(60), undefined)).toEqual({
      kind: "files",
      root: "/repo",
      files: modified(50),
      omitted: 10,
    });
  });
});
