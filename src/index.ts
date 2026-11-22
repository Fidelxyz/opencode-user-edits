import { setTimeout as delay } from "node:timers/promises";

import { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent } from "@opencode/client";
import type { SelectedEvent } from "@opencode/client/promise/api";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { SessionMessage } from "@opencode/schema/session-message";

import { attachUserEdits, injectUserEdits } from "./inject.ts";
import { createSnapshotStore, snapshotDataDir } from "./snapshot.ts";
import { createDiffTracker, type DiffTracker, type DiffTrackerDeps } from "./tracker.ts";

export default Plugin.define({ id: "user-edits", setup });

async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const tracker = createDiffTracker({
    store: createSnapshotStore(snapshotDataDir()),
    trackedSession: trackedSessionResolver(ctx),
  });
  const lifecycle = new AbortController();
  const watching = watchSessionEvents(ctx, tracker, lifecycle.signal);

  const prompt = await ctx.session.hook("prompt", async (event) => {
    try {
      const edits = await tracker.userEdits(event.sessionID, event.messageID);
      if (edits !== undefined) event.metadata = attachUserEdits(event.metadata, edits);
    } catch (error) {
      // Never block the prompt: it goes through without edits.
      reportError("failed to compute user edits", error);
    }
  });
  const context = await ctx.session.hook("context", (event) => inject(event));
  const compaction = await ctx.session.hook("compaction", (event) => inject(event));

  async function inject(event: SessionContext): Promise<void> {
    const stored = (await ctx.session.context({
      sessionID: event.sessionID,
    })) as unknown as readonly SessionMessage.Info[];
    injectUserEdits(event.messages, stored);
  }

  return async () => {
    lifecycle.abort();
    await watching;
    await prompt.dispose();
    await context.dispose();
    await compaction.dispose();
  };
}

/** Delay before resubscribing after the event subscription failed or ended. */
const RESUBSCRIBE_DELAY_MS = 1000;

async function watchSessionEvents(ctx: Plugin.Context, tracker: DiffTracker, signal: AbortSignal): Promise<void> {
  const handlers = new Set<Promise<void>>();

  while (!signal.aborted) {
    try {
      await dispatchSessionEvents(ctx, tracker, signal, handlers);
      if (signal.aborted) break;

      reportError("event subscription ended, resubscribing");
    } catch (error) {
      if (signal.aborted) break;

      reportError("event subscription failed, resubscribing", error);
    }

    await delay(RESUBSCRIBE_DELAY_MS, undefined, { signal }).catch(() => undefined);
  }

  await Promise.all(handlers);
}

const TRACKED_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.revert.committed",
  "session.forked",
  "session.deleted",
] as const;

type TrackedSessionEvent = SelectedEvent<OpenCodeEvent, (typeof TRACKED_EVENT_TYPES)[number]>;

async function dispatchSessionEvents(
  ctx: Plugin.Context,
  tracker: DiffTracker,
  signal: AbortSignal,
  handlers: Set<Promise<void>>,
): Promise<void> {
  const events = ctx.event.subscribe({
    types: [...TRACKED_EVENT_TYPES],
    signal,
  });

  for await (const event of events) {
    // The tracker serializes work per session, so events are dispatched without waiting for earlier ones.
    const handler = handleSessionEvent(tracker, event).catch((error: unknown) =>
      reportError(`failed to handle ${event.type}`, error),
    );
    handlers.add(handler);
    void handler.then(() => handlers.delete(handler));
  }
}

function handleSessionEvent(tracker: DiffTracker, event: TrackedSessionEvent): Promise<void> {
  switch (event.type) {
    case "session.execution.started":
      tracker.markRunning(event.data.sessionID);
      return Promise.resolve();
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return tracker.captureBaseline(event.data.sessionID);
    case "session.revert.committed":
      return tracker.revertTo(event.data.sessionID, event.data.to);
    case "session.forked":
      return tracker.forkFrom(event.data.sessionID, event.data.parentID, event.data.boundary);
    case "session.deleted":
      return tracker.forget(event.data.sessionID);
  }
}

function trackedSessionResolver(ctx: Plugin.Context): DiffTrackerDeps["trackedSession"] {
  return async (sessionID) => {
    const session = await ctx.session.get({ sessionID });
    if (session.parentID !== undefined) return undefined;

    return { directory: session.location.directory, revertMessageID: session.revert?.messageID };
  };
}

/** The plugin context offers no logging facility, so errors go to stderr. */
function reportError(message: string, error?: unknown): void {
  if (error === undefined) console.error(`user-edits: ${message}`);
  else console.error(`user-edits: ${message}:`, error);
}
