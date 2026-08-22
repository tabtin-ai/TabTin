import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type TabdocLongTitleWrapPreparation = {
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
    titleLength: number;
    expectedMinLines: number;
  };
  contextItem: {
    id: string;
    resourceId: string;
    title: string;
  };
  source: "electron-e2e-tabdoc-long-title-wrap";
};

export async function prepareTabdocLongTitleWrap(
  context: RunContext,
): Promise<TabdocLongTitleWrapPreparation> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdoc_long_title_wrap_case.py', encoding='utf-8').read())",
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
  await context.writeText("logs/tabdoc-long-title-wrap-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<Omit<TabdocLongTitleWrapPreparation, "source">>(
    result.stdout,
    "@@E2E@@",
  );
  const summary: TabdocLongTitleWrapPreparation = {
    ...prepared,
    source: "electron-e2e-tabdoc-long-title-wrap",
  };
  await context.writeJson("snapshots/tabdoc-long-title-wrap-preparation.json", summary);
  return summary;
}
