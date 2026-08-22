import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "./electron-local-auth";
import { readElectronSelection, type ElectronSelection } from "./electron-selection";

export type TabDocCommentMentionMemberPreparation = {
  runId: string;
  marker: string;
  auth?: E2eAuthPayload;
  owner: {
    userId: string;
    displayName: string;
    email: string;
  };
  mentionedMember: {
    userId: string;
    displayName: string;
    email: string;
    role: string;
    created: boolean;
  };
  organizationId: string;
  space: {
    id: string;
    name: string;
    type: string;
  };
  document: {
    id: string;
    title: string;
    spaceId: string;
    organizationId: string;
  };
  comment: {
    text: string;
    expectedMentionText: string;
  };
  source: "electron-e2e-tabdoc-comment-mention-member";
};

function redactAuthOutput(stdout: string): string {
  return stdout
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"<redacted>"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"<redacted>"');
}

async function readElectronSelectionAfterAuthBootstrap(
  context: RunContext,
  authPayload: E2eAuthPayload,
): Promise<ElectronSelection> {
  const expectedUserId = String(authPayload.userInfo.id ?? "");
  const expectedOrganizationId = String(authPayload.organization.id ?? "");
  const expectedSpaceId = String(authPayload.space.id ?? "");
  const expectedSpaceType = String(authPayload.space.type ?? "");
  const allowExecutionMirrorSpace = expectedSpaceType === "team_space";
  const deadline = Date.now() + 45_000;
  let lastError = "Electron selection is not ready after local auth bootstrap.";
  while (Date.now() < deadline) {
    try {
      const selection = readElectronSelection(context);
      if (
        selection.userId === expectedUserId &&
        selection.organizationId === expectedOrganizationId &&
        (selection.spaceId === expectedSpaceId || allowExecutionMirrorSpace)
      ) {
        return selection;
      }
      lastError = `Electron selection did not switch to TabDoc comment mention context: ${JSON.stringify({
        expected: {
          userId: expectedUserId,
          organizationId: expectedOrganizationId,
          spaceId: expectedSpaceId,
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

export async function prepareTabDocCommentMentionMember(
  context: RunContext,
): Promise<TabDocCommentMentionMemberPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdoc_comment_mention_member_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "prepare",
        TABTIN_E2E_RUN_ID: context.runId,
      },
    },
  );
  await context.writeText("logs/tabdoc-comment-mention-member-prepare-django.log", redactAuthOutput(result.stdout));
  const prepared = parseJsonSentinel<TabDocCommentMentionMemberPreparation>(result.stdout, "@@E2E@@");
  if (!prepared.auth) {
    throw new Error("tabdoc.comment-mention-member prepare output missing auth payload.");
  }

  await saveElectronAuthPayload(context, prepared.auth, "tabdoc-comment-mention-member");
  const selection = await readElectronSelectionAfterAuthBootstrap(context, prepared.auth);
  await context.writeJson("snapshots/tabdoc-comment-mention-member-electron-selection.json", selection);

  const summary: TabDocCommentMentionMemberPreparation = {
    ...prepared,
    auth: undefined,
    source: "electron-e2e-tabdoc-comment-mention-member",
  };
  await context.writeJson("snapshots/tabdoc-comment-mention-member-preparation.json", summary);
  return summary;
}
