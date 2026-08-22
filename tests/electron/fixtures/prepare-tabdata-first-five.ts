import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { readElectronSelection } from "./electron-selection";

export type TabDataFirstFivePreparation = {
  runId: string;
  marker: string;
  userId: string;
  organizationId: string;
  spaceId: string;
  organizationCreated: boolean;
  spaceCreated: boolean;
  source: "electron-selection-mirror";
};

export async function prepareTabDataFirstFive(
  context: RunContext,
): Promise<TabDataFirstFivePreparation> {
  const selection = readElectronSelection(context);
  await context.writeJson("snapshots/tabdata-first-five-electron-selection.json", selection);

  const djangoResult = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdata_first_five_prepare.py', encoding='utf-8').read())",
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
  await context.writeText("logs/tabdata-first-five-prepare-django.log", djangoResult.stdout);
  const prepared = parseJsonSentinel<Omit<TabDataFirstFivePreparation, "source">>(
    djangoResult.stdout,
    "@@E2E@@",
  );
  const summary: TabDataFirstFivePreparation = {
    ...prepared,
    source: "electron-selection-mirror",
  };
  await context.writeJson("snapshots/tabdata-first-five-preparation.json", summary);
  return summary;
}
