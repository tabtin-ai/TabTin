import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type ChatViewportAnchorPreparation = {
  runId: string;
  marker: string;
  organizationId: string;
  userId: string;
  spaceId: string;
  sessionId: string;
  longMessageId: string;
  messageCount?: number;
  lastMessageId?: string;
  lastRole?: string;
  longMessageChars?: number;
  organizationCreated?: boolean;
  spaceCreated?: boolean;
  sessionCreated?: boolean;
  userCreated?: boolean;
  inviteRedeemed?: boolean;
  seedReused?: boolean;
  source: "electron-e2e-chat-viewport-anchor";
};

export async function prepareChatViewportAnchor(
  context: RunContext,
): Promise<ChatViewportAnchorPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/chat_viewport_anchor_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 90_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "prepare",
        TABTIN_E2E_RUN_ID: context.runId,
      },
    },
  );
  await context.writeText("logs/chat-viewport-anchor-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<Omit<ChatViewportAnchorPreparation, "source">>(
    result.stdout,
    "@@E2E@@",
  );
  if (
    typeof prepared.runId !== "string" ||
    prepared.runId !== context.runId ||
    typeof prepared.organizationId !== "string" ||
    typeof prepared.userId !== "string" ||
    typeof prepared.spaceId !== "string" ||
    typeof prepared.sessionId !== "string" ||
    typeof prepared.longMessageId !== "string" ||
    typeof prepared.marker !== "string"
  ) {
    throw new Error(
      `chat.viewport-anchor-preservation prepare contract mismatch: ${JSON.stringify({
        expectedRunId: context.runId,
        actualRunId: prepared.runId,
        prepared,
      })}`,
    );
  }
  const summary: ChatViewportAnchorPreparation = {
    ...prepared,
    source: "electron-e2e-chat-viewport-anchor",
  };
  await context.writeJson("snapshots/chat-viewport-anchor-preparation.json", summary);
  return summary;
}
