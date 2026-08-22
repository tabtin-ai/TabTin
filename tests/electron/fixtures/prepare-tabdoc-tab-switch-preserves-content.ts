import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { readElectronSelection } from "./electron-selection";

export type TabdocTabSwitchPreparation = {
  runId: string;
  spaceId: string;
  organizationId: string;
  userId: string;
  docAId: string;
  docBId: string;
  docATitle: string;
  docBTitle: string;
  leadMarkerA: string;
  leadMarkerB: string;
  source: "electron-selection-mirror";
};

export async function prepareTabdocTabSwitchPreservesContent(
  context: RunContext,
): Promise<TabdocTabSwitchPreparation> {
  const selection = readElectronSelection(context);
  await context.writeJson(
    "snapshots/tabdoc-tab-switch-preserves-content-electron-selection.json",
    selection,
  );

  const djangoResult = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdoc_tab_switch_preserves_content_prepare.py', encoding='utf-8').read())",
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
  await context.writeText(
    "logs/tabdoc-tab-switch-preserves-content-prepare-django.log",
    djangoResult.stdout,
  );
  const prepared = parseJsonSentinel<Omit<TabdocTabSwitchPreparation, "source">>(
    djangoResult.stdout,
    "@@E2E@@",
  );
  const summary: TabdocTabSwitchPreparation = {
    ...prepared,
    source: "electron-selection-mirror",
  };
  await context.writeJson(
    "snapshots/tabdoc-tab-switch-preserves-content-preparation.json",
    summary,
  );
  return summary;
}
