import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { readElectronSelection } from "./electron-selection";

export type TabDocBasicEditPreparation = {
  runId: string;
  docId: string;
  spaceId: string;
  organizationId: string;
  userId: string;
  title: string;
  marker: string;
  initialMarkdown: string;
  editMarkdown: string;
  organizationCreated: boolean;
  spaceCreated: boolean;
  source: "electron-selection-mirror";
};

export async function prepareTabDocBasicEdit(
  context: RunContext
): Promise<TabDocBasicEditPreparation> {
  const selection = readElectronSelection(context);
  await context.writeJson("snapshots/tabdoc-basic-edit-electron-selection.json", selection);

  const djangoResult = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdoc_basic_edit_prepare.py', encoding='utf-8').read())",
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
      },
    },
  );
  await context.writeText("logs/tabdoc-basic-edit-prepare-django.log", djangoResult.stdout);
  const prepared = parseJsonSentinel<Omit<TabDocBasicEditPreparation, "editMarkdown" | "source">>(
    djangoResult.stdout,
    "@@E2E@@",
  );
  const summary: TabDocBasicEditPreparation = {
    ...prepared,
    editMarkdown: `# ${prepared.marker}-edited\n\nEdited through the real Electron TabDoc probe.`,
    source: "electron-selection-mirror",
  };
  await context.writeJson("snapshots/tabdoc-basic-edit-preparation.json", summary);
  return summary;
}
