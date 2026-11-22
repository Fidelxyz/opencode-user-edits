import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { createKeyedQueue } from "./queue.ts";

export interface Worktree {
  readonly root: string;
  readonly commonDir: string;
}

export type TreeID = string;

/** The worktree state a session's later edits are measured against. */
export interface Baseline {
  readonly tree: TreeID;
  /** Commit HEAD pointed to; undefined in a repository without commits. */
  readonly head: string | undefined;
}

/** Where a session keeps a baseline. */
export type BaselineSlot = { readonly kind: "current" } | { readonly kind: "prompt"; readonly messageID: string };

/** The baseline the session's next prompt is measured against. */
export const CURRENT_BASELINE: BaselineSlot = { kind: "current" };

/** The baseline the user prompt with this message ID was measured against. */
export function promptBaseline(messageID: string): BaselineSlot {
  return { kind: "prompt", messageID };
}

export interface SnapshotStore {
  capture(worktree: Worktree): Promise<TreeID>;
  saveBaseline(worktree: Worktree, sessionID: string, slot: BaselineSlot, baseline: Baseline): Promise<void>;
  readBaseline(worktree: Worktree, sessionID: string, slot: BaselineSlot): Promise<Baseline | undefined>;
  /** Deletes every baseline of the session, in all worktrees. */
  removeSessionBaselines(sessionID: string): Promise<void>;
  /** `git diff --name-status` lines, relative to the worktree root. */
  changes(worktree: Worktree, from: TreeID, to: TreeID): Promise<readonly string[]>;
  /** The unified diff; undefined when it exceeds maxChars or the base content is unavailable. */
  patch(worktree: Worktree, from: TreeID, to: TreeID, maxChars: number): Promise<string | undefined>;
}

export function snapshotDataDir(): string {
  const dataHome = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "user-edits");
}

export async function findWorktree(directory: string): Promise<Worktree | undefined> {
  let output: GitResult;
  try {
    output = await runGit(["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: directory });
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.stderr)) return undefined;
    throw error;
  }

  const [root, commonDir] = output.stdout.trimEnd().split("\n") as [string, string];

  return { root, commonDir: isAbsolute(commonDir) ? commonDir : resolve(directory, commonDir) };
}

/** Resolves the commit HEAD points to; undefined when the repository has no commits yet. */
export async function findHead(worktree: Worktree): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: worktree.root });
    return stdout.trim();
  } catch (error) {
    // `--quiet` makes an unresolvable HEAD fail without any message.
    if (error instanceof GitError && error.stderr.trim() === "") return undefined;
    throw error;
  }
}

export function createSnapshotStore(dataDir: string): SnapshotStore {
  const captureQueue = createKeyedQueue();

  return {
    capture(worktree) {
      return captureQueue.run(worktree.root, async () => {
        const gitDir = storeGitDir(dataDir, worktree);
        await prepareStoreGitDir(gitDir, worktree);

        const options = { gitDir, workTree: worktree.root };
        await runGit(["add", "-A"], options);
        const { stdout } = await runGit(["write-tree"], options);
        await runGit(["gc", "--auto", "--quiet"], options);

        return stdout.trim();
      });
    },

    async saveBaseline(worktree, sessionID, slot, baseline) {
      const gitDir = storeGitDir(dataDir, worktree);
      const refs = baselineRefs(sessionID, slot);

      if (baseline.head === undefined) await runGit(["update-ref", "-d", refs.head], { gitDir });
      else await runGit(["update-ref", refs.head, baseline.head], { gitDir });
      await runGit(["update-ref", refs.tree, baseline.tree], { gitDir });
    },

    async readBaseline(worktree, sessionID, slot) {
      const gitDir = storeGitDir(dataDir, worktree);
      if (!(await isStoreInitialized(gitDir))) return undefined;

      const refs = baselineRefs(sessionID, slot);
      const { stdout } = await runGit(["for-each-ref", "--format=%(refname) %(objectname)", `${refs.prefix}/`], {
        gitDir,
      });
      const objects = new Map(
        stdout
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.split(" ") as [string, string]),
      );

      const tree = objects.get(refs.tree);
      return tree === undefined ? undefined : { tree, head: objects.get(refs.head) };
    },

    async removeSessionBaselines(sessionID) {
      const entries = await readdir(dataDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });

      const prefix = `${sessionRefsPrefix(sessionID)}/`;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const gitDir = join(dataDir, entry.name);
        const { stdout } = await runGit(["for-each-ref", "--format=%(refname)", prefix], { gitDir });
        const refNames = stdout.split("\n").filter((name) => name !== "");
        if (refNames.length === 0) continue;

        await runGit(["update-ref", "--stdin"], { gitDir, stdin: refNames.map((name) => `delete ${name}\n`).join("") });
      }
    },

    async changes(worktree, from, to) {
      const gitDir = storeGitDir(dataDir, worktree);
      const listChanges = (renames: string) =>
        runGit(["diff-tree", "-r", "--name-status", renames, from, to], { gitDir });

      // Rename detection reads file contents, which the repository may no longer have.
      const { stdout } = await listChanges("-M").catch((error: unknown) => {
        if (isMissingObjectError(error)) return listChanges("--no-renames");
        throw error;
      });

      return stdout.split("\n").filter((line) => line !== "");
    },

    async patch(worktree, from, to, maxChars) {
      const gitDir = storeGitDir(dataDir, worktree);
      try {
        const args = [
          "diff-tree",
          "-r", // recurse
          "-p", // output a patch
          "-U1", // one context line
          "-M", // show renames rather than full old and new contents
          "--irreversible-delete", // omit the contents of deleted files
          "--no-prefix", // show paths without the a/ and b/ prefixes
          from,
          to,
        ];
        const result = await runGit(args, {
          gitDir,
          maxOutput: maxChars * 2, // The headroom covers the header lines compaction removes.
        });
        if (result.truncated) return undefined;

        const patch = compactPatch(result.stdout);
        return patch.length > maxChars ? undefined : patch;
      } catch (error) {
        if (isMissingObjectError(error)) return undefined;
        throw error;
      }
    },
  };
}

/** Drops file header lines that repeat the `diff --git` line's paths or name blob hashes. */
function compactPatch(patch: string): string {
  let inFileHeader = false;
  return patch
    .split("\n")
    .filter((line) => {
      if (line.startsWith("diff --git ")) inFileHeader = true;
      else if (line.startsWith("@@ ")) inFileHeader = false;

      return !(inFileHeader && /^(index |--- |\+\+\+ )/.test(line));
    })
    .join("\n");
}

function isMissingObjectError(error: unknown): boolean {
  return error instanceof GitError && /unable to read|bad object|missing object/i.test(error.stderr);
}

function storeGitDir(dataDir: string, worktree: Worktree): string {
  return join(dataDir, createHash("sha1").update(worktree.root).digest("hex"));
}

function storeAlternatesFile(gitDir: string): string {
  return join(gitDir, "objects", "info", "alternates");
}

/** Initialization writes `objects/info/alternates` last, so its presence means initialization completed. */
async function isStoreInitialized(gitDir: string): Promise<boolean> {
  try {
    await access(storeAlternatesFile(gitDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function prepareStoreGitDir(gitDir: string, worktree: Worktree): Promise<void> {
  if (!(await isStoreInitialized(gitDir))) {
    // Every step tolerates an earlier, interrupted run.
    await runGit(["init", "--quiet", "--bare", gitDir], {});
    await runGit(["config", "core.bare", "false"], { gitDir });
    await runGit(["config", "gc.pruneExpire", "1.hour.ago"], { gitDir });
    await writeFile(storeAlternatesFile(gitDir), `${join(worktree.commonDir, "objects")}\n`);
  }

  const exclude = await readFile(join(worktree.commonDir, "info", "exclude"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(join(gitDir, "info", "exclude"), exclude);
}

function sessionRefsPrefix(sessionID: string): string {
  return `refs/sessions/${sessionID}`;
}

function baselineRefs(sessionID: string, slot: BaselineSlot) {
  const sessionPrefix = sessionRefsPrefix(sessionID);
  const prefix = slot.kind === "current" ? `${sessionPrefix}/current` : `${sessionPrefix}/prompts/${slot.messageID}`;
  return { prefix, tree: `${prefix}/tree`, head: `${prefix}/head` };
}

/** Variables that would redirect git to a repository other than the one a command names. */
const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const name of GIT_LOCATION_ENV) delete env[name];

  return env;
}

interface GitRunOptions {
  readonly cwd?: string;
  readonly gitDir?: string;
  readonly workTree?: string;
  /** Stops reading and kills git once stdout exceeds this many characters. */
  readonly maxOutput?: number;
  /** Written to git's stdin; stdin is closed when unset. */
  readonly stdin?: string;
}

interface GitResult {
  readonly stdout: string;
  readonly truncated: boolean;
}

class GitError extends Error {
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    super(`user-edits: git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.stderr = stderr;
  }
}

function runGit(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
  const prefix: string[] = [];
  if (options.gitDir !== undefined) prefix.push(`--git-dir=${options.gitDir}`);
  if (options.workTree !== undefined) prefix.push(`--work-tree=${options.workTree}`);

  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...prefix, "-c", "core.quotePath=false", ...args], {
      cwd: options.cwd,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      stdout += chunk;
      if (options.maxOutput !== undefined && stdout.length > options.maxOutput) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    // Git reports a failure that ends it before reading stdin through its exit code.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
    child.on("close", (code) => {
      if (truncated || code === 0) resolvePromise({ stdout, truncated });
      else reject(new GitError(args, stderr));
    });
  });
}
