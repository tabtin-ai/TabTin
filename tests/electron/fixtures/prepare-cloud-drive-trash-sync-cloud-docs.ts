import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type CloudDriveTrashSyncCloudDocsPreparation = {
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
  document: {
    id: string;
    title: string;
    contextItemId: string;
  };
  table: {
    id: string;
    name: string;
    contextItemId: string;
  };
  source: "electron-e2e-cloud-trash-sync";
};

export async function prepareCloudDriveTrashSyncCloudDocs(
  context: RunContext,
): Promise<CloudDriveTrashSyncCloudDocsPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/cloud_drive_trash_sync_cloud_docs_case.py', encoding='utf-8').read())",
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
  await context.writeText("logs/cloud-drive-trash-sync-cloud-docs-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<Omit<CloudDriveTrashSyncCloudDocsPreparation, "source">>(
    result.stdout,
    "@@E2E@@",
  );
  const summary: CloudDriveTrashSyncCloudDocsPreparation = {
    ...prepared,
    source: "electron-e2e-cloud-trash-sync",
  };
  await context.writeJson("snapshots/cloud-drive-trash-sync-cloud-docs-preparation.json", summary);
  return summary;
}
