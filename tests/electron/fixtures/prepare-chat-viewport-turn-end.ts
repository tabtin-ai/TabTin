import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type ChatViewportTurnEndPreparation = {
  runId: string;
  marker: string;
  organizationId: string | null;
  userId: string | null;
  spaceId: string | null;
  sessionId: string | null;
  /** Bound Agent id on the run-scoped Space; null when fixture could not provision one. */
  agentId: string | null;
  deviceId: string | null;
  /** False means no existing executable Space was found. */
  agentReady: boolean;
  deviceReady: boolean;
  workingDirReady: boolean;
  preferredModelReady: boolean;
  membershipReady: boolean;
  membershipProvisioned: boolean;
  organizationMemberReady: boolean;
  usesExistingExecutionSpace: boolean;
  selectionStrategy: string;
  requestedSpaceIdProvided: boolean;
  messageCount?: number;
  clearedMessageCount?: number;
  organizationCreated?: boolean;
  spaceCreated?: boolean;
  sessionCreated?: boolean;
  userCreated?: boolean;
  inviteRedeemed?: boolean;
  source: "electron-e2e-chat-viewport-turn-end";
};

function assertPreparationContract(
  prepared: Omit<ChatViewportTurnEndPreparation, "source">,
  runId: string,
): void {
  if (
    typeof prepared.runId !== "string" ||
    prepared.runId !== runId ||
    typeof prepared.marker !== "string" ||
    typeof prepared.agentReady !== "boolean" ||
    typeof prepared.deviceReady !== "boolean" ||
    typeof prepared.workingDirReady !== "boolean" ||
    typeof prepared.preferredModelReady !== "boolean" ||
    typeof prepared.membershipReady !== "boolean" ||
    typeof prepared.membershipProvisioned !== "boolean" ||
    typeof prepared.organizationMemberReady !== "boolean" ||
    typeof prepared.usesExistingExecutionSpace !== "boolean" ||
    typeof prepared.selectionStrategy !== "string" ||
    typeof prepared.requestedSpaceIdProvided !== "boolean" ||
    !(prepared.organizationId === null || typeof prepared.organizationId === "string") ||
    !(prepared.userId === null || typeof prepared.userId === "string") ||
    !(prepared.spaceId === null || typeof prepared.spaceId === "string") ||
    !(prepared.sessionId === null || typeof prepared.sessionId === "string") ||
    !(prepared.agentId === null || typeof prepared.agentId === "string") ||
    !(prepared.deviceId === null || typeof prepared.deviceId === "string")
  ) {
    throw new Error(
      `chat.viewport-turn-end-stability prepare contract mismatch: ${JSON.stringify({
        expectedRunId: runId,
        actualRunId: prepared.runId,
        prepared,
      })}`,
    );
  }
  if (
    prepared.usesExistingExecutionSpace &&
    !(
      prepared.agentReady &&
      prepared.deviceReady &&
      prepared.workingDirReady &&
      prepared.preferredModelReady &&
      prepared.membershipReady &&
      prepared.organizationMemberReady &&
      typeof prepared.organizationId === "string" &&
      typeof prepared.userId === "string" &&
      typeof prepared.spaceId === "string" &&
      typeof prepared.sessionId === "string" &&
      typeof prepared.agentId === "string" &&
      typeof prepared.deviceId === "string"
    )
  ) {
    throw new Error(
      `chat.viewport-turn-end-stability prepare contract mismatch: existing execution Space must be fully ready (${JSON.stringify(prepared)})`,
    );
  }
  if (
    !prepared.usesExistingExecutionSpace &&
    !(
      prepared.organizationId === null &&
      prepared.userId === null &&
      prepared.spaceId === null &&
      prepared.sessionId === null &&
      prepared.agentId === null &&
      prepared.deviceId === null &&
      !prepared.agentReady &&
      !prepared.deviceReady &&
      !prepared.workingDirReady
    )
  ) {
    throw new Error(
      `chat.viewport-turn-end-stability prepare contract mismatch: unavailable environment must not expose target ids (${JSON.stringify(prepared)})`,
    );
  }
}

export async function prepareChatViewportTurnEnd(
  context: RunContext,
): Promise<ChatViewportTurnEndPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/chat_viewport_turn_end_case.py', encoding='utf-8').read())",
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
  await context.writeText("logs/chat-viewport-turn-end-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<Omit<ChatViewportTurnEndPreparation, "source">>(
    result.stdout,
    "@@E2E@@",
  );
  assertPreparationContract(prepared, context.runId);
  const summary: ChatViewportTurnEndPreparation = {
    ...prepared,
    source: "electron-e2e-chat-viewport-turn-end",
  };
  await context.writeJson("snapshots/chat-viewport-turn-end-preparation.json", summary);
  return summary;
}
