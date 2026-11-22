import { createKeyedQueue, type KeyedQueue } from "./queue.ts";
import { describeUserEdits, type UserEdits } from "./report.ts";
import {
  CURRENT_BASELINE,
  findHead,
  findWorktree,
  promptBaseline,
  type Baseline,
  type SnapshotStore,
  type Worktree,
} from "./snapshot.ts";

/** Session facts the tracker needs; child sessions are not tracked. */
export interface TrackedSession {
  readonly directory: string;
  /** First message a staged revert removes. */
  readonly revertMessageID: string | undefined;
}

/** Fork point: "before" excludes the message, "through" includes it. Structurally matches Session.ForkBoundary. */
export interface ForkBoundary {
  readonly type: "before" | "through";
  readonly messageID: string;
}

export interface DiffTrackerDeps {
  readonly store: SnapshotStore;
  /** undefined for child sessions. */
  readonly trackedSession: (sessionID: string) => Promise<TrackedSession | undefined>;
}

export interface DiffTracker {
  markRunning(sessionID: string): void;
  /** Clears the running mark, captures the worktree and saves it as the session baseline (no-op outside git). */
  captureBaseline(sessionID: string): Promise<void>;
  /** Rewinds current to a staged revert's target first; records the compared baseline (the live worktree when none exists) as the message's prompt baseline, except for steered prompts. */
  userEdits(sessionID: string, messageID: string): Promise<UserEdits | undefined>;
  /** After a revert commits: current := prompt baseline of messageID, or a live capture when none was recorded. */
  revertTo(sessionID: string, messageID: string): Promise<void>;
  /** Sets the fork's current from the parent's baseline at the fork point; leaves it unset when none. */
  forkFrom(sessionID: string, parentID: string, boundary: ForkBoundary): Promise<void>;
  forget(sessionID: string): Promise<void>;
}

export function createDiffTracker(deps: DiffTrackerDeps): DiffTracker {
  const running = new Set<string>();
  const sessionQueue: KeyedQueue = createKeyedQueue();

  async function locateSession(
    sessionID: string,
  ): Promise<{ worktree: Worktree; session: TrackedSession } | undefined> {
    const session = await deps.trackedSession(sessionID);
    if (session === undefined) return undefined;

    const worktree = await findWorktree(session.directory);
    return worktree === undefined ? undefined : { worktree, session };
  }

  async function captureWorktree(worktree: Worktree): Promise<Baseline> {
    return { tree: await deps.store.capture(worktree), head: await findHead(worktree) };
  }

  async function captureCurrentBaseline(sessionID: string): Promise<void> {
    const located = await locateSession(sessionID);
    if (located === undefined) return;

    const { worktree } = located;
    await deps.store.saveBaseline(worktree, sessionID, CURRENT_BASELINE, await captureWorktree(worktree));
  }

  async function rewindCurrentBaseline(worktree: Worktree, sessionID: string, messageID: string): Promise<void> {
    const baseline =
      (await deps.store.readBaseline(worktree, sessionID, promptBaseline(messageID))) ??
      (await captureWorktree(worktree));
    await deps.store.saveBaseline(worktree, sessionID, CURRENT_BASELINE, baseline);
  }

  async function forkPointBaseline(
    worktree: Worktree,
    parentID: string,
    boundary: ForkBoundary,
  ): Promise<Baseline | undefined> {
    const slot = boundary.type === "before" ? promptBaseline(boundary.messageID) : CURRENT_BASELINE;
    return deps.store.readBaseline(worktree, parentID, slot);
  }

  return {
    markRunning(sessionID) {
      running.add(sessionID);
    },

    captureBaseline(sessionID) {
      running.delete(sessionID);

      return sessionQueue.run(sessionID, () => captureCurrentBaseline(sessionID));
    },

    userEdits(sessionID, messageID) {
      return sessionQueue.run(sessionID, async () => {
        if (running.has(sessionID)) return undefined;

        const located = await locateSession(sessionID);
        if (located === undefined) return undefined;

        const { worktree, session } = located;
        if (session.revertMessageID !== undefined) {
          await rewindCurrentBaseline(worktree, sessionID, session.revertMessageID);
        }

        const baseline = await deps.store.readBaseline(worktree, sessionID, CURRENT_BASELINE);
        const current = await captureWorktree(worktree);
        if (baseline === undefined) {
          await deps.store.saveBaseline(worktree, sessionID, promptBaseline(messageID), current);
          return undefined;
        }

        await deps.store.saveBaseline(worktree, sessionID, promptBaseline(messageID), baseline);
        return describeUserEdits(deps.store, worktree, baseline, current);
      });
    },

    revertTo(sessionID, messageID) {
      return sessionQueue.run(sessionID, async () => {
        const located = await locateSession(sessionID);
        if (located === undefined) return;

        await rewindCurrentBaseline(located.worktree, sessionID, messageID);
      });
    },

    forkFrom(sessionID, parentID, boundary) {
      return sessionQueue.run(sessionID, async () => {
        await sessionQueue.idle(parentID);

        const located = await locateSession(sessionID);
        if (located === undefined) return;

        const { worktree } = located;
        const baseline = await forkPointBaseline(worktree, parentID, boundary);
        if (baseline !== undefined) await deps.store.saveBaseline(worktree, sessionID, CURRENT_BASELINE, baseline);
      });
    },

    forget(sessionID) {
      running.delete(sessionID);

      return sessionQueue.run(sessionID, () => deps.store.removeSessionBaselines(sessionID));
    },
  };
}
