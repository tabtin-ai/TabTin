import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { createElectronChatSession } from "./electron-chat-session";
import { ensureElectronLocalAuth, type E2eAuthPayload } from "./electron-local-auth";
import { readElectronRuntimeConfig, requireLocalElectronApiBaseUrl } from "./electron-runtime-config";
import { readElectronSelection, type ElectronSelection } from "./electron-selection";

export type ChatMessagePersistencePreparation = {
  runId: string;
  marker: string;
  messageText: string;
  userId: string;
  organizationId: string;
  spaceId: string;
  sessionId: string;
  organizationCreated: boolean;
  spaceCreated: boolean;
  sessionCreated: boolean;
  source: "electron-e2e-local-auth";
};

async function readElectronSelectionAfterAuthBootstrap(
  context: RunContext,
  authPayload: E2eAuthPayload,
): Promise<ElectronSelection> {
  const expectedUserId = String(authPayload.userInfo.id ?? "");
  const deadline = Date.now() + 45000;
  let lastError = "Electron selection is not ready after local auth bootstrap.";
  while (Date.now() < deadline) {
    try {
      const selection = readElectronSelection(context);
      if (
        selection.userId === expectedUserId &&
        selection.organizationId === authPayload.organization.id &&
        selection.spaceId === authPayload.space.id
      ) {
        return selection;
      }
      lastError = `Electron selection did not switch to E2E context: ${JSON.stringify({
        expected: {
          userId: expectedUserId,
          organizationId: authPayload.organization.id,
          spaceId: authPayload.space.id,
        },
        actual: selection,
      })}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(lastError);
}

export async function prepareChatMessagePersistence(
  context: RunContext,
): Promise<ChatMessagePersistencePreparation> {
  const runtimeConfig = readElectronRuntimeConfig(context);
  await context.writeJson("snapshots/chat-message-electron-runtime-config.json", runtimeConfig);
  requireLocalElectronApiBaseUrl(runtimeConfig);

  try {
    const previousSelection = readElectronSelection(context);
    await context.writeJson("snapshots/chat-message-electron-selection-before-auth.json", previousSelection);
  } catch (error) {
    await context.writeText(
      "logs/chat-message-electron-selection-initial-error.log",
      error instanceof Error ? error.message : String(error),
    );
  }

  const authPayload = await ensureElectronLocalAuth(context);
  const selection = await readElectronSelectionAfterAuthBootstrap(context, authPayload);
  const chatSession = createElectronChatSession(context, selection);
  await context.writeJson("snapshots/chat-message-electron-selection.json", selection);
  await context.writeJson("snapshots/chat-message-electron-session.json", chatSession);

  const djangoResult = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/chat_message_persistence_prepare.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
      env: {
        ...process.env,
        TABTIN_E2E_RUN_ID: context.runId,
        TABTIN_E2E_USER_ID: selection.userId,
        TABTIN_E2E_ORGANIZATION_ID: selection.organizationId,
        TABTIN_E2E_ORGANIZATION_NAME: selection.organizationName,
        TABTIN_E2E_SPACE_ID: selection.spaceId,
        TABTIN_E2E_SPACE_NAME: selection.spaceName,
        TABTIN_E2E_SESSION_ID: chatSession.sessionId,
      },
    },
  );
  await context.writeText("logs/chat-message-persistence-prepare-django.log", djangoResult.stdout);
  const summary = parseJsonSentinel<Omit<ChatMessagePersistencePreparation, "source">>(
    djangoResult.stdout,
    "@@E2E@@",
  );
  const prepared: ChatMessagePersistencePreparation = {
    ...summary,
    source: "electron-e2e-local-auth",
  };
  await context.writeJson("snapshots/chat-message-preparation.json", prepared);
  return prepared;
}
