import { describe, expect, it } from "vitest";
import { DateTime } from "effect";
import { Message } from "@opencode/ai/effect";
import { SessionMessage } from "@opencode/schema/session-message";
import { USER_EDITS_METADATA_KEY, attachUserEdits, formatUserEdits, injectUserEdits } from "../src/inject.ts";
import type { UserEdits } from "../src/report.ts";

const PATCH_EDITS: UserEdits = { kind: "patch", root: "/repo", patch: "diff --git a/a.txt b/a.txt\n-old\n+new\n" };

function requestMessage(id: string, text: string): Message {
  return Message.make({ id, role: "user", content: [{ type: "text", text }] });
}

function storedMessage(id: string, metadata?: Record<string, unknown>): SessionMessage.Info {
  return SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    text: "fix it",
    time: { created: DateTime.makeUnsafe(0) },
    ...(metadata ? { metadata } : {}),
  });
}

function textsOf(message: Message): string[] {
  return (message.content as readonly { type: string; text?: string }[]).map((part) => part.text ?? "");
}

describe("attachUserEdits", () => {
  it("preserves existing metadata", () => {
    expect(attachUserEdits({ other: 1 }, PATCH_EDITS)).toEqual({ other: 1, [USER_EDITS_METADATA_KEY]: PATCH_EDITS });
  });
});

describe("injectUserEdits", () => {
  it("appends the edits to the tagged user message", () => {
    const original = requestMessage("msg_1", "fix it");
    const messages = [original];

    injectUserEdits(messages, [storedMessage("msg_1", attachUserEdits(undefined, PATCH_EDITS))]);

    expect(messages[0]).not.toBe(original);
    expect(textsOf(original)).toEqual(["fix it"]);
    expect(textsOf(messages[0]!)).toEqual(["fix it", formatUserEdits(PATCH_EDITS)]);
  });

  it("leaves untagged messages unchanged", () => {
    const original = requestMessage("msg_1", "fix it");
    const messages = [original];

    injectUserEdits(messages, [storedMessage("msg_1", { other: 1 })]);

    expect(messages[0]).toBe(original);
    expect(textsOf(original)).toEqual(["fix it"]);
  });
});

describe("formatUserEdits", () => {
  it("formats a patch block with the worktree root", () => {
    const text = formatUserEdits(PATCH_EDITS);

    expect(text.startsWith('<user-edits root="/repo">')).toBe(true);
    expect(text).toContain(PATCH_EDITS.kind === "patch" ? PATCH_EDITS.patch : "");
    expect(text.trimEnd().endsWith("</user-edits>")).toBe(true);
  });

  it("escapes the root attribute", () => {
    const text = formatUserEdits({ ...PATCH_EDITS, root: '/a&b"c<d' });

    expect(text.startsWith('<user-edits root="/a&amp;b&quot;c&lt;d">')).toBe(true);
  });

  it("names the HEAD move with short commits", () => {
    const text = formatUserEdits({ ...PATCH_EDITS, headChange: { from: "a".repeat(40), to: null } });

    expect(text).toContain("HEAD moved from aaaaaaa to no HEAD");
  });

  it("formats a file list with the omitted count", () => {
    const text = formatUserEdits({
      kind: "files",
      root: "/repo",
      files: ["M\ta.txt", "D\tb.txt"],
      omitted: 3,
    });

    expect(text).toContain("M\ta.txt");
    expect(text).toContain("D\tb.txt");
    expect(text).toContain("... and 3 more files");
  });
});
