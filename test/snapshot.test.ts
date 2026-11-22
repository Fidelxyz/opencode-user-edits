import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_BASELINE,
  createSnapshotStore,
  findHead,
  findWorktree,
  promptBaseline,
  type FileChange,
  type Worktree,
} from "../src/snapshot.ts";
import { createGitRepo, createStore, createTempDir } from "./fixtures.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function worktreeOf(root: string): Promise<Worktree> {
  const worktree = await findWorktree(root);
  if (!worktree) throw new Error(`${root} is not a git worktree`);

  return worktree;
}

function sorted(changes: readonly FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("findWorktree", () => {
  it("returns undefined outside a git repository", async () => {
    expect(await findWorktree(await createTempDir())).toBeUndefined();
  });

  it("resolves the toplevel from a subdirectory", async () => {
    const repo = await createGitRepo();
    await repo.write("src/deep/file.txt", "x");

    const worktree = await worktreeOf(join(repo.root, "src/deep"));

    expect(worktree.root).toBe(repo.root);
    expect(worktree.commonDir).toBe(join(repo.root, ".git"));
  });
});

describe("SnapshotStore", () => {
  it("lists added, modified and deleted files between captures", async () => {
    const repo = await createGitRepo();
    await repo.write("a.txt", "a");
    await repo.write("b.txt", "b");
    await repo.commit("add files");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const before = await store.capture(worktree);
    await repo.write("a.txt", "a2");
    await repo.write("c.txt", "c");
    await repo.remove("b.txt");
    const after = await store.capture(worktree);

    expect(sorted(await store.changes(worktree, before, after))).toEqual([
      { status: "M", path: "a.txt" },
      { status: "D", path: "b.txt" },
      { status: "A", path: "c.txt" },
    ]);
  });

  it("captures untracked files and honors .gitignore", async () => {
    const repo = await createGitRepo();
    await repo.write(".gitignore", "ignored.txt\n");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const before = await store.capture(worktree);
    await repo.write("untracked.txt", "u");
    await repo.write("ignored.txt", "i");
    const after = await store.capture(worktree);

    expect(await store.changes(worktree, before, after)).toEqual([{ status: "A", path: "untracked.txt" }]);
  });

  it("honors the repository info/exclude", async () => {
    const repo = await createGitRepo();
    await writeFile(join(repo.root, ".git/info/exclude"), "excluded.txt\n");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const before = await store.capture(worktree);
    await repo.write("excluded.txt", "e");
    await repo.write("kept.txt", "k");
    const after = await store.capture(worktree);

    expect(await store.changes(worktree, before, after)).toEqual([{ status: "A", path: "kept.txt" }]);
  });

  it("leaves the repository index and objects untouched", async () => {
    const repo = await createGitRepo();
    await repo.write("tracked.txt", "t");
    await repo.commit("add tracked");
    await repo.write("tracked.txt", "t2");
    await repo.write("untracked.txt", "u");
    const store = await createStore();
    const gitDir = join(repo.root, ".git");
    const snapshot = async () => ({
      index: await readFile(join(gitDir, "index")),
      objects: await listFiles(join(gitDir, "objects")),
      refs: await git(repo.root, "for-each-ref"),
    });
    const before = await snapshot();

    await store.capture(await worktreeOf(repo.root));

    expect(await snapshot()).toEqual(before);
  });

  it("leaves the repository index untouched when GIT_INDEX_FILE points at it", async () => {
    const repo = await createGitRepo();
    await repo.write("untracked.txt", "u");
    const store = await createStore();
    const index = join(repo.root, ".git", "index");
    const before = await readFile(index);
    vi.stubEnv("GIT_INDEX_FILE", index);

    await store.capture(await worktreeOf(repo.root));

    expect(await readFile(index)).toEqual(before);
  });

  it("completes initialization of a store interrupted before writing alternates", async () => {
    const repo = await createGitRepo();
    const dataDir = await createTempDir();
    const worktree = await worktreeOf(repo.root);
    await createSnapshotStore(dataDir).capture(worktree);
    const [storeName] = await readdir(dataDir);
    await rm(join(dataDir, storeName!, "objects", "info", "alternates"));

    await createSnapshotStore(dataDir).capture(worktree);

    expect(await readFile(join(dataDir, storeName!, "objects", "info", "alternates"), "utf8")).toContain(
      ".git/objects",
    );
  });

  it("keeps baselines across store instances", async () => {
    const repo = await createGitRepo();
    const dataDir = await createTempDir();
    const worktree = await worktreeOf(repo.root);
    const baseline = { tree: await createSnapshotStore(dataDir).capture(worktree), head: await findHead(worktree) };

    await createSnapshotStore(dataDir).saveBaseline(worktree, "ses_1", CURRENT_BASELINE, baseline);

    expect(await createSnapshotStore(dataDir).readBaseline(worktree, "ses_1", CURRENT_BASELINE)).toEqual(baseline);
  });

  it("removeSessionBaselines deletes every baseline of the session", async () => {
    const repo = await createGitRepo();
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);
    const baseline = { tree: await store.capture(worktree), head: undefined };
    await store.saveBaseline(worktree, "ses_1", CURRENT_BASELINE, baseline);
    await store.saveBaseline(worktree, "ses_1", promptBaseline("msg_1"), baseline);

    await store.removeSessionBaselines("ses_1");

    expect(await store.readBaseline(worktree, "ses_1", CURRENT_BASELINE)).toBeUndefined();
    expect(await store.readBaseline(worktree, "ses_1", promptBaseline("msg_1"))).toBeUndefined();
  });

  it("removeSessionBaselines keeps baselines of sessions sharing an ID prefix", async () => {
    const repo = await createGitRepo();
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);
    const baseline = { tree: await store.capture(worktree), head: undefined };
    await store.saveBaseline(worktree, "ses_10", CURRENT_BASELINE, baseline);

    await store.removeSessionBaselines("ses_1");

    expect(await store.readBaseline(worktree, "ses_10", CURRENT_BASELINE)).toEqual(baseline);
  });

  it("serializes concurrent captures of one worktree", async () => {
    const repo = await createGitRepo();
    await repo.write("a.txt", "a");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const trees = await Promise.all(Array.from({ length: 5 }, () => store.capture(worktree)));

    expect(new Set(trees).size).toBe(1);
  });

  it("returns a patch without redundant file headers", async () => {
    const repo = await createGitRepo();
    await repo.write("a.txt", "-- old\n");
    await repo.commit("add a");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const before = await store.capture(worktree);
    await repo.write("a.txt", "new\n");
    const after = await store.capture(worktree);

    expect(await store.patch(worktree, before, after, 10_000)).toBe(
      "diff --git a.txt a.txt\n@@ -1 +1 @@\n--- old\n+new\n",
    );
  });

  it("omits the contents of deleted files from the patch", async () => {
    const repo = await createGitRepo();
    await repo.write("gone.txt", "secret contents\n");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const before = await store.capture(worktree);
    await repo.remove("gone.txt");
    const after = await store.capture(worktree);

    const patch = await store.patch(worktree, before, after, 10_000);

    expect(patch).toContain("deleted file mode");
    expect(patch).not.toContain("secret contents");
  });

  it("reports an oversized patch beyond maxChars", async () => {
    const repo = await createGitRepo();
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);

    const before = await store.capture(worktree);
    await repo.write("big.txt", "line\n".repeat(1000));
    const after = await store.capture(worktree);

    expect(await store.patch(worktree, before, after, 100)).toBeUndefined();
  });

  it("reports an unavailable patch when base content is gone", async () => {
    const repo = await createGitRepo();
    await repo.write("base.txt", "committed\n");
    await repo.commit("add base");
    const store = await createStore();
    const worktree = await worktreeOf(repo.root);
    const blob = await git(repo.root, "rev-parse", "HEAD:base.txt");

    const before = await store.capture(worktree);
    await repo.write("base.txt", "edited\n");
    const after = await store.capture(worktree);
    await rm(join(repo.root, ".git/objects", blob.slice(0, 2), blob.slice(2)));

    expect(await store.patch(worktree, before, after, 10_000)).toBeUndefined();
  });
});
