import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDiffTracker, type DiffTracker } from "../src/tracker.ts";
import type { SnapshotStore } from "../src/snapshot.ts";
import { createGitRepo, createStore, createTempDir } from "./fixtures.ts";

const SESSION = "ses_1";
const FORK = "ses_fork";
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

interface TrackerOptions {
  readonly store?: SnapshotStore;
  /** Staged revert target per session; mutable mid-test. */
  readonly reverts?: Record<string, string>;
}

async function createTracker(
  directories: Record<string, string | undefined>,
  options: TrackerOptions = {},
): Promise<DiffTracker> {
  return createDiffTracker({
    store: options.store ?? (await createStore()),
    trackedSession: async (sessionID) => {
      const directory = directories[sessionID];

      return directory === undefined ? undefined : { directory, revertMessageID: options.reverts?.[sessionID] };
    },
  });
}

function patchText(edits: Awaited<ReturnType<DiffTracker["userEdits"]>>): string {
  return edits?.kind === "patch" ? edits.patch : "";
}

describe("DiffTracker", () => {
  it("reports edits made between the baseline and the next prompt", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: repo.root });

    await tracker.captureBaseline(SESSION);
    await repo.write("user.txt", "by hand\n");

    expect(patchText(await tracker.userEdits(SESSION, "msg_1"))).toContain("user.txt");
  });

  it("reports nothing before the first baseline", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: repo.root });
    await repo.write("user.txt", "by hand\n");

    expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
  });

  it("reports nothing while the session is running", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: repo.root });
    await tracker.captureBaseline(SESSION);

    tracker.markRunning(SESSION);
    await repo.write("user.txt", "by hand\n");

    expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
  });

  it("waits for a pending baseline before comparing", async () => {
    const repo = await createGitRepo();
    const realStore = await createStore();
    let baselineSaving: (() => void) | undefined;
    let releaseBaseline: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseBaseline = resolve));
    const store: SnapshotStore = {
      ...realStore,
      saveBaseline: async (...args) => {
        baselineSaving?.();
        await gate;
        await realStore.saveBaseline(...args);
      },
    };
    const tracker = await createTracker({ [SESSION]: repo.root }, { store });
    const saving = new Promise<void>((resolve) => (baselineSaving = resolve));
    await repo.write("before.txt", "earlier\n");

    // The baseline tree is captured, but not yet saved, while the user edits another file.
    const baseline = tracker.captureBaseline(SESSION);
    await saving;
    await repo.write("after.txt", "later\n");
    const edits = tracker.userEdits(SESSION, "msg_1");
    releaseBaseline();
    await baseline;

    const text = patchText(await edits);
    expect(text).toContain("after.txt");
    expect(text).not.toContain("before.txt");
  });

  it("reports nothing outside a git repository", async () => {
    const directory = await createTempDir();
    const tracker = await createTracker({ [SESSION]: directory });

    await tracker.captureBaseline(SESSION);

    expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
  });

  it("reports nothing after the session moves to another worktree", async () => {
    const original = await createGitRepo();
    const moved = await createGitRepo();
    const directories = { [SESSION]: original.root };
    const tracker = await createTracker(directories);
    await tracker.captureBaseline(SESSION);

    directories[SESSION] = moved.root;
    await moved.write("user.txt", "by hand\n");

    expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
  });

  it("reports nothing for sessions without a tracked directory", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: undefined });

    await tracker.captureBaseline(SESSION);
    await repo.write("user.txt", "by hand\n");

    expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
  });

  it("reports a HEAD move together with the edits", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: repo.root });
    await tracker.captureBaseline(SESSION);
    const before = await git(repo.root, "rev-parse", "HEAD");

    await repo.write("committed.txt", "c\n");
    await repo.commit("user commit");
    await repo.write("loose.txt", "l\n");
    const after = await git(repo.root, "rev-parse", "HEAD");

    const edits = await tracker.userEdits(SESSION, "msg_1");
    expect(edits).toMatchObject({ kind: "patch", headChange: { from: before, to: after } });
  });

  it("reports a HEAD move when the worktree is unchanged", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: repo.root });
    await tracker.captureBaseline(SESSION);

    await repo.commit("empty commit");

    expect(await tracker.userEdits(SESSION, "msg_1")).toMatchObject({ kind: "head" });
  });

  describe("revert", () => {
    async function trackPromptEdit(tracker: DiffTracker, repo: Awaited<ReturnType<typeof createGitRepo>>) {
      await tracker.captureBaseline(SESSION);
      await repo.write("a.txt", "a\n");
      expect(patchText(await tracker.userEdits(SESSION, "msg_1"))).toContain("a.txt");
      await tracker.captureBaseline(SESSION);
    }

    it("reports edits again after reverting the first prompt", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root });
      expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
      await tracker.captureBaseline(SESSION);
      await repo.write("a.txt", "a\n");

      await tracker.revertTo(SESSION, "msg_1");

      expect(patchText(await tracker.userEdits(SESSION, "msg_2"))).toContain("a.txt");
    });

    it("reports edits again after reverting the prompt that carried them", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root });
      await trackPromptEdit(tracker, repo);

      await tracker.revertTo(SESSION, "msg_1");

      expect(patchText(await tracker.userEdits(SESSION, "msg_2"))).toContain("a.txt");
    });

    it("rewinds before comparing when a revert is staged", async () => {
      const repo = await createGitRepo();
      const reverts: Record<string, string> = {};
      const tracker = await createTracker({ [SESSION]: repo.root }, { reverts });
      await trackPromptEdit(tracker, repo);

      reverts[SESSION] = "msg_1";

      expect(patchText(await tracker.userEdits(SESSION, "msg_2"))).toContain("a.txt");
    });

    it("absorbs the worktree when the revert target has no prompt baseline", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root });
      await tracker.captureBaseline(SESSION);
      await repo.write("restored.txt", "r\n");

      await tracker.revertTo(SESSION, "msg_unknown");

      expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
    });

    it("records no prompt baseline for a steered prompt", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root });
      await tracker.captureBaseline(SESSION);
      tracker.markRunning(SESSION);
      expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
      await tracker.captureBaseline(SESSION);
      await repo.write("x.txt", "x\n");

      await tracker.revertTo(SESSION, "msg_1");

      expect(await tracker.userEdits(SESSION, "msg_2")).toBeUndefined();
    });
  });

  describe("fork", () => {
    it("starts a fork before a prompt from the parent's baseline for that prompt", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root, [FORK]: repo.root });
      await tracker.captureBaseline(SESSION);
      await repo.write("a.txt", "a\n");
      await tracker.userEdits(SESSION, "msg_1");
      await tracker.captureBaseline(SESSION);

      await tracker.forkFrom(FORK, SESSION, { type: "before", messageID: "msg_1" });

      expect(patchText(await tracker.userEdits(FORK, "msg_f1"))).toContain("a.txt");
    });

    it("starts a fork through the latest message from the parent's current baseline", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root, [FORK]: repo.root });
      await tracker.captureBaseline(SESSION);

      await tracker.forkFrom(FORK, SESSION, { type: "through", messageID: "msg_1" });
      await repo.write("b.txt", "b\n");

      expect(patchText(await tracker.userEdits(FORK, "msg_f1"))).toContain("b.txt");
    });

    it("leaves a fork without baseline when the fork point has no prompt baseline", async () => {
      const repo = await createGitRepo();
      const tracker = await createTracker({ [SESSION]: repo.root, [FORK]: repo.root });
      await tracker.captureBaseline(SESSION);

      await tracker.forkFrom(FORK, SESSION, { type: "before", messageID: "msg_unknown" });
      await repo.write("b.txt", "b\n");

      expect(await tracker.userEdits(FORK, "msg_f1")).toBeUndefined();
    });
  });

  it("forget drops the session baseline", async () => {
    const repo = await createGitRepo();
    const tracker = await createTracker({ [SESSION]: repo.root });
    await tracker.captureBaseline(SESSION);

    await tracker.forget(SESSION);
    await repo.write("user.txt", "by hand\n");

    expect(await tracker.userEdits(SESSION, "msg_1")).toBeUndefined();
  });
});
