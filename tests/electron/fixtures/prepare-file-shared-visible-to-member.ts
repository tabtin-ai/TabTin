import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import type { E2eAuthPayload } from "./electron-local-auth";
import { readElectronSelection, type ElectronSelection } from "./electron-selection";

export type FileSharedVisibleToMemberPreparation = {
  runId: string;
  marker: string;
  teamName: string;
  organizationId: string;
  targetSpace: {
    id: string;
    name: string;
    type: string;
  };
  ownerSpace: {
    id: string;
    name: string;
    type: string;
  };
  owner: {
    userId: string;
    displayName: string;
    email: string;
  };
  viewerMember: {
    userId: string;
    displayName: string;
    email: string;
    role: string;
  };
  members: Array<{
    key: string;
    userId: string;
    displayName: string;
    email: string;
    role: string;
    created: boolean;
  }>;
  memberUserIds: string[];
  resource?: {
    resourceType: "doc";
    documentId: string;
    title: string;
    organizationId: string;
    spaceId: string;
  };
  share?: {
    permission: string;
    notified: number;
    skipped: Array<{ user_id?: string; reason?: string }>;
    permissionCount: number;
  };
  source: "electron-e2e-member-shared-file";
};

export async function readElectronSelectionAfterAuthBootstrap(
  context: RunContext,
  authPayload: E2eAuthPayload,
): Promise<ElectronSelection> {
  const expectedUserId = String(authPayload.userInfo.id ?? "");
  const expectedSpaceType = String(authPayload.space.type ?? "");
  const allowExecutionMirrorSpace = expectedSpaceType === "team_space";
  const deadline = Date.now() + 45000;
  let lastError = "Electron selection is not ready after shared-file local auth bootstrap.";
  while (Date.now() < deadline) {
    try {
      const selection = readElectronSelection(context);
      if (
        selection.userId === expectedUserId &&
        selection.organizationId === authPayload.organization.id &&
        (selection.spaceId === authPayload.space.id || allowExecutionMirrorSpace)
      ) {
        return selection;
      }
      lastError = `Electron selection did not switch to shared-file E2E context: ${JSON.stringify({
        expected: {
          userId: expectedUserId,
          organizationId: authPayload.organization.id,
          spaceId: authPayload.space.id,
          allowExecutionMirrorSpace,
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

export async function prepareFileSharedVisibleToMember(
  context: RunContext,
): Promise<FileSharedVisibleToMemberPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/file_shared_visible_to_member_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "prepare",
        TABTIN_E2E_RUN_ID: context.runId,
      },
    },
  );
  await context.writeText("logs/file-shared-visible-to-member-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<FileSharedVisibleToMemberPreparation>(
    result.stdout,
    "@@E2E@@",
  );

  const summary: FileSharedVisibleToMemberPreparation = {
    ...prepared,
    source: "electron-e2e-member-shared-file",
  };
  await context.writeJson("snapshots/file-shared-visible-to-member-preparation.json", summary);
  return summary;
}
