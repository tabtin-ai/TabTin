import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type E2eAuthPayload = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userInfo: Record<string, unknown>;
  organization: Record<string, unknown> & { id: string };
  space: Record<string, unknown> & { id: string; organization_id: string };
  currentUserRole?: string;
  createdUser: boolean;
  e2eSpaceCreated: boolean;
  archivedE2eSpaceCount: number;
  inviteRedeemed: boolean;
};

function saveAuthExpression(payload: E2eAuthPayload): string {
  const selectedSpaceKind = payload.space.type === "team_space"
    ? "team"
    : typeof payload.space.type === "string"
      ? payload.space.type
      : "workspace";
  return `
(async () => {
  const payload = ${JSON.stringify(payload)};
  const selectedSpaceKind = ${JSON.stringify(selectedSpaceKind)};
  const saveResult = await window.tabtin.auth.save(
    payload.accessToken,
    payload.refreshToken,
    payload.userInfo,
    payload.expiresAt,
  );
  if (saveResult && saveResult.success === false) {
    throw new Error(saveResult.error || 'window.tabtin.auth.save failed');
  }
  localStorage.setItem('tabtin-organization-store', JSON.stringify({
    state: {
      organizations: [payload.organization],
      selectedOrganization: payload.organization,
      lastOpenedOrganizationId: payload.organization.id,
      currentUserRole: payload.currentUserRole || 'owner'
    },
    version: 2
  }));
  localStorage.setItem('tabtin-space-list', JSON.stringify({
    state: {
      selectedSpaceId: payload.space.id,
      selectedSpaceKind,
      selectionByOrganization: {
        [payload.organization.id]: {
          selectedSpaceId: payload.space.id,
          selectedSpaceKind
        }
      }
    },
    version: 4
  }));
  setTimeout(() => location.reload(), 500);
  return JSON.stringify({
    ok: true,
    userId: payload.userInfo.id,
    organizationId: payload.organization.id,
    spaceId: payload.space.id
  });
})()
`;
}

function redactAuthOutput(stdout: string): string {
  return stdout
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"<redacted>"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"<redacted>"');
}

export async function saveElectronAuthPayload(
  context: RunContext,
  payload: E2eAuthPayload,
  logPrefix: string,
): Promise<void> {
  await context.writeJson(`snapshots/${logPrefix}-local-auth.json`, {
    userInfo: payload.userInfo,
    organization: payload.organization,
    space: payload.space,
    currentUserRole: payload.currentUserRole,
    createdUser: payload.createdUser,
    e2eSpaceCreated: payload.e2eSpaceCreated,
    archivedE2eSpaceCount: payload.archivedE2eSpaceCount,
    inviteRedeemed: payload.inviteRedeemed,
  });

  runCommand("node", ["scripts/cdp-eval.mjs", saveAuthExpression(payload)], {
    cwd: context.repoRoot,
    timeoutMs: 60000,
  });
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

export async function ensureElectronLocalAuth(context: RunContext): Promise<E2eAuthPayload> {
  const djangoResult = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/chat_message_persistence_login.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
      env: { ...process.env, TABTIN_E2E_RUN_ID: context.runId },
    },
  );
  await context.writeText("logs/chat-message-local-auth-django.log", redactAuthOutput(djangoResult.stdout));
  const payload = parseJsonSentinel<E2eAuthPayload>(djangoResult.stdout, "@@E2E@@");
  await saveElectronAuthPayload(context, payload, "chat-message");
  return payload;
}
