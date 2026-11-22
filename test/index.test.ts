import { expect, test, vi } from "vitest";
import plugin from "../src/index.ts";
import {
  CURRENT_BASELINE,
  createSnapshotStore,
  findWorktree,
  promptBaseline,
  snapshotDataDir,
  type BaselineSlot,
} from "../src/snapshot.ts";
import {
  contextEvent,
  createFakePluginContext,
  createGitRepo,
  createTempDir,
  promptEvent,
  sessionID,
  type FakeSessions,
  type TestRepo,
  type SessionEventType,
} from "./fixtures.ts";

const SESSION = sessionID("ses_1");

async function startPlugin(sessions: FakeSessions) {
  vi.stubEnv("XDG_DATA_HOME", await createTempDir());
  const fake = createFakePluginContext(sessions);
  const cleanup = await plugin.setup(fake.ctx);

  return { fake, cleanup: async () => void (await cleanup?.()) };
}

async function finishExecution(
  fake: ReturnType<typeof createFakePluginContext>,
  type: Exclude<SessionEventType, "session.revert.committed" | "session.forked"> = "session.execution.succeeded",
) {
  await fake.emit({ type: "session.execution.started", data: { sessionID: SESSION } });
  await fake.emit({ type, data: { sessionID: SESSION } });
}

async function readBaseline(root: string, id = SESSION, slot: BaselineSlot = CURRENT_BASELINE) {
  const worktree = (await findWorktree(root))!;

  return createSnapshotStore(snapshotDataDir()).readBaseline(worktree, id, slot);
}

async function waitForBaseline(root: string, id = SESSION): Promise<void> {
  await vi.waitFor(async () => expect(await readBaseline(root, id)).toBeDefined());
}

async function userEditsText(fake: ReturnType<typeof createFakePluginContext>, messageID: string): Promise<string> {
  await fake.runPrompt(promptEvent(SESSION, messageID, "continue"));
  const context = contextEvent(SESSION, messageID, "continue");
  await fake.runContext(context);
  const parts = context.messages[0]!.content as readonly { type: string; text: string }[];

  return parts[parts.length - 1]!.text;
}

/** Runs a prompt that carries a user edit, then an execution that changes the worktree. */
async function runEditedTurn(fake: ReturnType<typeof createFakePluginContext>, repo: TestRepo) {
  await finishExecution(fake);
  await waitForBaseline(repo.root);
  await repo.write("user.txt", "edited by hand\n");
  await userEditsText(fake, "msg_1");
  const before = await readBaseline(repo.root);

  await repo.write("agent.txt", "by agent\n");
  await finishExecution(fake);
  await vi.waitFor(async () => expect((await readBaseline(repo.root))?.tree).not.toBe(before?.tree));
}

test("injects edits made between turns into the next model request", async () => {
  const repo = await createGitRepo();
  const { fake, cleanup } = await startPlugin({ directories: { [SESSION]: repo.root } });

  await finishExecution(fake);
  await waitForBaseline(repo.root);
  await repo.write("user.txt", "edited by hand\n");
  await fake.runPrompt(promptEvent(SESSION, "msg_1", "continue"));

  const context = contextEvent(SESSION, "msg_1", "continue");
  await fake.runContext(context);

  const parts = context.messages[0]!.content as readonly { type: string; text: string }[];
  expect(parts[0]!.text).toBe("continue");
  expect(parts[parts.length - 1]!.text).toContain("user.txt");

  await cleanup();
});

test("rewinds to the staged revert target on the next prompt", async () => {
  const repo = await createGitRepo();
  const reverts: Record<string, string> = {};
  const { fake, cleanup } = await startPlugin({ directories: { [SESSION]: repo.root }, reverts });
  await runEditedTurn(fake, repo);

  reverts[SESSION] = "msg_1";

  expect(await userEditsText(fake, "msg_2")).toContain("user.txt");

  await cleanup();
});

test("rewinds the baseline when a revert commits", async () => {
  const repo = await createGitRepo();
  const { fake, cleanup } = await startPlugin({ directories: { [SESSION]: repo.root } });
  await runEditedTurn(fake, repo);

  await fake.emit({ type: "session.revert.committed", data: { sessionID: SESSION, to: "msg_1" } });

  const target = await readBaseline(repo.root, SESSION, promptBaseline("msg_1"));
  await vi.waitFor(async () => expect(await readBaseline(repo.root)).toEqual(target));

  await cleanup();
});

test("starts a forked session from the parent's baseline", async () => {
  const repo = await createGitRepo();
  const fork = sessionID("ses_fork");
  const { fake, cleanup } = await startPlugin({ directories: { [SESSION]: repo.root, [fork]: repo.root } });
  await finishExecution(fake);
  await waitForBaseline(repo.root);

  await fake.emit({
    type: "session.forked",
    data: { sessionID: fork, parentID: SESSION, boundary: { type: "through", messageID: "msg_1" } },
  });

  await waitForBaseline(repo.root, fork);

  await cleanup();
});

test("keeps handling events after one event fails", async () => {
  const repo = await createGitRepo();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { fake, cleanup } = await startPlugin({ directories: { [SESSION]: repo.root } });

  await fake.emit({ type: "session.execution.succeeded", data: { sessionID: sessionID("ses_unknown") } });
  await finishExecution(fake);

  await waitForBaseline(repo.root);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("user-edits:"), expect.any(Error));

  await cleanup();
  error.mockRestore();
});

test("resubscribes after the event subscription fails", async () => {
  const repo = await createGitRepo();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { fake, cleanup } = await startPlugin({ directories: { [SESSION]: repo.root } });

  await fake.failSubscription(new Error("stream closed"));
  await finishExecution(fake);

  await waitForBaseline(repo.root);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("resubscribing"), expect.any(Error));

  await cleanup();
  error.mockRestore();
});

test("lets the prompt through when computing edits fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { fake, cleanup } = await startPlugin({ directories: {} });
  const prompt = promptEvent(SESSION, "msg_1", "continue");

  await fake.runPrompt(prompt);

  expect(prompt.metadata).toBeUndefined();
  expect(error).toHaveBeenCalledOnce();

  await cleanup();
  error.mockRestore();
});

test("captures no baseline for child sessions", async () => {
  const repo = await createGitRepo();
  const child = sessionID("ses_child");
  const { fake, cleanup } = await startPlugin({
    directories: { [SESSION]: repo.root, [child]: repo.root },
    children: [child],
  });

  await fake.emit({ type: "session.execution.succeeded", data: { sessionID: child } });
  await finishExecution(fake);
  await waitForBaseline(repo.root);

  expect(await readBaseline(repo.root, child)).toBeUndefined();

  await cleanup();
});
