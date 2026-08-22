import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type FileDragMoveBetweenFoldersPreparation = {
  runId: string;
  marker: string;
  prepared: boolean;
  authUser: {
    userId: string;
    created: boolean;
    inviteRedeemed: boolean;
  };
  organization: {
    id: string;
    name: string;
  };
  space: {
    id: string;
    name: string;
    type: string;
  };
  rootFolder: {
    name: string;
    path: string;
  };
  sourceFolder: {
    id: string;
    name: string;
    path: string;
  };
  targetFolder: {
    id: string;
    name: string;
    path: string;
  };
  file: {
    name: string;
    resourceId: string;
    contextItemId: string;
    initialCollectionId: string;
    expectedCollectionIdAfterMove: string;
  };
  source: "electron-e2e-file-drag-move";
};

export async function prepareFileDragMoveBetweenFolders(
  context: RunContext,
): Promise<FileDragMoveBetweenFoldersPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/file_drag_move_between_folders_case.py', encoding='utf-8').read())",
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
  await context.writeText("logs/file-drag-move-between-folders-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<Omit<FileDragMoveBetweenFoldersPreparation, "source">>(
    result.stdout,
    "@@E2E@@",
  );
  const summary: FileDragMoveBetweenFoldersPreparation = {
    ...prepared,
    source: "electron-e2e-file-drag-move",
  };
  await context.writeJson("snapshots/file-drag-move-between-folders-preparation.json", summary);
  return summary;
}
