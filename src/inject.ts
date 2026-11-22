import { Message } from "@opencode/ai/effect";

import type { SessionMessage } from "@opencode/schema/session-message";

import type { UserEdits } from "./report.ts";

export const USER_EDITS_METADATA_KEY = "user-edits";

export function attachUserEdits(
  metadata: Record<string, unknown> | undefined,
  edits: UserEdits,
): Record<string, unknown> {
  return { ...metadata, [USER_EDITS_METADATA_KEY]: edits };
}

export function injectUserEdits(messages: Message[], stored: readonly SessionMessage.Info[]): void {
  const editsByMessageID = new Map<string, UserEdits>();
  for (const message of stored) {
    if (message.type !== "user") continue;

    const edits = readUserEdits(message.metadata);
    if (edits !== undefined) editsByMessageID.set(message.id, edits);
  }

  messages.forEach((message, index) => {
    if (message.role !== "user" || message.id === undefined) return;

    const edits = editsByMessageID.get(message.id);
    if (edits === undefined) return;

    messages[index] = Message.make({
      ...message,
      content: [...message.content, { type: "text", text: formatUserEdits(edits) }],
    });
  });
}

export function formatUserEdits(edits: UserEdits): string {
  const lines = [`<user-edits root="${escapeAttribute(edits.root)}">`];

  if (edits.headChange) {
    lines.push(`HEAD moved from ${shortCommitHash(edits.headChange.from)} to ${shortCommitHash(edits.headChange.to)}`);
  }

  if (edits.kind !== "head") {
    lines.push("These files changed after the previous turn ended:");

    if (edits.kind === "patch") {
      lines.push(edits.patch.trimEnd());
    } else {
      // edits.kind === "files"
      lines.push(...edits.files);
      if (edits.omitted > 0) lines.push(`... and ${edits.omitted} more files`);
    }
  }

  lines.push("</user-edits>");
  return lines.join("\n");
}

function readUserEdits(metadata: Record<string, unknown> | undefined): UserEdits | undefined {
  return metadata?.[USER_EDITS_METADATA_KEY] as UserEdits | undefined;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function shortCommitHash(commit: string | null): string {
  return commit === null ? "no HEAD" : commit.slice(0, 7);
}
