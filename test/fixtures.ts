import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DateTime } from "effect";
import { afterEach, vi } from "vitest";
import { Message } from "@opencode/ai/effect";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session";
import { Agent } from "@opencode/schema/agent";
import { Model } from "@opencode/schema/model";
import { Session } from "@opencode/schema/session";
import { SessionID } from "@opencode/schema/session-id";
import { SessionMessage } from "@opencode/schema/session-message";
import { createSnapshotStore, type SnapshotStore } from "../src/snapshot.ts";
import type { ForkBoundary } from "../src/tracker.ts";

const execFileAsync = promisify(execFile);

// Isolate every git invocation (tests and implementation) from the host configuration.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export interface TestRepo {
  readonly root: string;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  commit(message: string): Promise<void>;
}

export async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "user-edits-"));
  tempDirs.push(dir);

  return dir;
}

export async function createGitRepo(): Promise<TestRepo> {
  const root = await createTempDir();
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });

  const repo: TestRepo = {
    root,
    async write(path, content) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    async remove(path) {
      await rm(join(root, path), { force: true });
    },
    async commit(message) {
      await git("add", "-A");
      await git("commit", "-q", "--allow-empty", "-m", message);
    },
  };

  await git("init", "-q");
  await repo.commit("initial commit");

  return repo;
}

export async function createStore(): Promise<SnapshotStore> {
  return createSnapshotStore(await createTempDir());
}

export type SessionEventType =
  | "session.execution.started"
  | "session.execution.succeeded"
  | "session.execution.failed"
  | "session.execution.interrupted"
  | "session.deleted"
  | "session.revert.committed"
  | "session.forked";

export type SessionEvent =
  | {
      readonly type: Exclude<SessionEventType, "session.revert.committed" | "session.forked">;
      readonly data: { readonly sessionID: Session.ID };
    }
  | {
      readonly type: "session.revert.committed";
      readonly data: { readonly sessionID: Session.ID; readonly to: string };
    }
  | {
      readonly type: "session.forked";
      readonly data: {
        readonly sessionID: Session.ID;
        readonly parentID: Session.ID;
        readonly boundary: ForkBoundary;
      };
    };

export interface FakeSessions {
  /** Directory per session; a session listed in `children` reports a parent. */
  readonly directories: Record<string, string>;
  readonly children?: readonly string[];
  /** Staged revert target per session; mutable mid-test. */
  readonly reverts?: Record<string, string>;
}

export interface FakePluginContext {
  readonly ctx: Plugin.Context;
  emit(event: SessionEvent): Promise<void>;
  /** Makes the current event subscription throw. */
  failSubscription(failure: Error): Promise<void>;
  /** Runs the prompt hook, then stores the (possibly annotated) message like the host does. */
  runPrompt(event: SessionPrompt): Promise<void>;
  runContext(event: SessionContext): Promise<void>;
}

export function sessionID(id: string): Session.ID {
  return SessionID.make(id);
}

export function promptEvent(id: Session.ID, messageID: string, text: string): SessionPrompt {
  return { sessionID: id, messageID: SessionMessage.ID.make(messageID), prompt: { text }, delivery: "queue" };
}

export function contextEvent(id: Session.ID, messageID: string, text: string): SessionContext {
  return {
    sessionID: id,
    agent: Agent.ID.make("build"),
    model: Model.Ref.parse("anthropic/claude"),
    system: [],
    messages: [Message.make({ id: messageID, role: "user", content: [{ type: "text", text }] })],
    options: {},
    tools: {},
  };
}

type QueuedEvent =
  | { readonly event: SessionEvent; readonly handled: () => void }
  | { readonly failure: Error; readonly handled: () => void };

type HookCallback = (event: never) => Promise<void> | void;

export function createFakePluginContext({ directories, children = [], reverts }: FakeSessions): FakePluginContext {
  const queue: QueuedEvent[] = [];
  const hooks = new Map<string, HookCallback>();
  const storedMessages = new Map<string, SessionMessage.Info[]>();
  let wake: (() => void) | undefined;

  const next = async (signal: AbortSignal | undefined): Promise<QueuedEvent | undefined> => {
    while (!signal?.aborted) {
      const item = queue.shift();
      if (item) return item;

      await new Promise<void>((resolve) => {
        wake = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };

  // The generator resumes only after the consumer finished its loop body, so `handled` marks a dispatched event.
  async function* subscribe(options?: { signal?: AbortSignal }) {
    for (let item = await next(options?.signal); item; item = await next(options?.signal)) {
      if ("failure" in item) {
        item.handled();
        throw item.failure;
      }

      yield item.event;
      item.handled();
    }
  }

  // Only the surface the plugin uses is faked; the full Plugin.Context is impractical to construct.
  const ctx = {
    event: { subscribe },
    session: {
      hook: async (name: string, callback: HookCallback) => {
        hooks.set(name, callback);
        return { dispose: async () => void hooks.delete(name) };
      },
      context: async ({ sessionID }: { sessionID: string }) => storedMessages.get(sessionID) ?? [],
      get: async ({ sessionID }: { sessionID: string }) => {
        const directory = directories[sessionID];
        if (directory === undefined) throw new Error(`Unknown session ${sessionID}`);

        return {
          location: { directory },
          ...(reverts?.[sessionID] !== undefined ? { revert: { messageID: reverts[sessionID] } } : {}),
          ...(children.includes(sessionID) ? { parentID: SessionID.make("ses_parent") } : {}),
        };
      },
    },
  } as unknown as Plugin.Context;

  async function callHook(name: "prompt" | "context", event: SessionPrompt | SessionContext): Promise<void> {
    const callback = hooks.get(name);
    if (!callback) throw new Error(`Hook ${name} is not registered`);

    await callback(event as never);
  }

  return {
    ctx,
    emit: (event) =>
      new Promise<void>((resolve) => {
        queue.push({ event, handled: resolve });
        wake?.();
      }),
    failSubscription: (failure) =>
      new Promise<void>((resolve) => {
        queue.push({ failure, handled: resolve });
        wake?.();
      }),
    async runPrompt(event) {
      await callHook("prompt", event);

      const stored = storedMessages.get(event.sessionID) ?? [];
      stored.push(
        SessionMessage.User.make({
          id: event.messageID,
          text: event.prompt.text,
          time: { created: DateTime.makeUnsafe(0) },
          ...(event.metadata ? { metadata: event.metadata } : {}),
        }),
      );
      storedMessages.set(event.sessionID, stored);
    },
    runContext: (event) => callHook("context", event),
  };
}
