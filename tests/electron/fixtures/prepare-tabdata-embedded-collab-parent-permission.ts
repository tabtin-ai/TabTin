import type { RunContext } from '../runner/types';
import {
  parseJsonSentinel,
  resolvePythonCommand,
  runCommand,
} from '../runner/process';

export type TabdataEmbeddedCollabParentPermissionPreparation = {
  runId: string;
  marker: string;
  organizationId: string;
  ownerSpaceId: string;
  navigationSpaceId: string;
  ownerUserId: string;
  collaboratorUserId: string;
  documentId: string;
  documentTitle: string;
  unrelatedDocumentId: string;
  tableId: string;
  tableTitle: string;
  fieldId: string;
  recordId: string;
  initialValue: string;
  editedValue: string;
  prepared: true;
};

export async function prepareTabdataEmbeddedCollabParentPermission(
  context: RunContext,
): Promise<TabdataEmbeddedCollabParentPermissionPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      'apps/tabtin_django/manage.py',
      'shell',
      '-c',
      "exec(open('tests/electron/fixtures/tabdata_embedded_collab_parent_permission_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: 'prepare',
        TABTIN_E2E_RUN_ID: context.runId,
      },
    },
  );
  await context.writeText(
    'logs/tabdata-embedded-collab-parent-permission-prepare-django.log',
    result.stdout,
  );
  const prepared =
    parseJsonSentinel<TabdataEmbeddedCollabParentPermissionPreparation>(
      result.stdout,
      '@@E2E@@',
    );
  await context.writeJson(
    'snapshots/tabdata-embedded-collab-parent-permission-preparation.json',
    prepared,
  );
  return prepared;
}
