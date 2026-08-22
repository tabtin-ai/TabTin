import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "./electron-local-auth";
import { readElectronSelection, type ElectronSelection } from "./electron-selection";

export type TabDataMemberMentionPreparation = {
  runId: string;
  marker: string;
  auth?: E2eAuthPayload;
  userId: string;
  organizationId: string;
  spaceId: string;
  spaceType: string;
  table: {
    id: string;
    name: string;
    fields: Array<{ id?: string; name: string; field_type: string; is_primary: boolean; config?: Record<string, unknown> }>;
  };
  tableCreated: boolean;
  record: {
    id: string;
    title: string;
  };
  fields: {
    title: { id: string; name: string };
    assignee: { id: string; name: string; field_type: string };
  };
  candidateMember: {
    userId: string;
    displayName: string;
    email: string;
    created: boolean;
  };
  source: "electron-e2e-team-auth";
};

async function readElectronSelectionAfterAuthBootstrap(
  context: RunContext,
  authPayload: E2eAuthPayload,
): Promise<ElectronSelection> {
  const expectedUserId = String(authPayload.userInfo.id ?? "");
  const expectedSpaceType = String(authPayload.space.type ?? "");
  const allowExecutionMirrorSpace = expectedSpaceType === "team_space";
  const deadline = Date.now() + 45000;
  let lastError = "Electron selection is not ready after local auth bootstrap.";
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
      lastError = `Electron selection did not switch to E2E context: ${JSON.stringify({
        expected: {
          userId: expectedUserId,
          organizationId: authPayload.organization.id,
          spaceId: authPayload.space.id,
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

export async function prepareTabDataMemberMention(
  context: RunContext,
): Promise<TabDataMemberMentionPreparation> {
  const djangoResult = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdata_member_mention_case.py', encoding='utf-8').read())",
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
  const redactedPrepareLog = djangoResult.stdout
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"');
  await context.writeText("logs/tabdata-member-mention-prepare-django.log", redactedPrepareLog);
  const prepared = parseJsonSentinel<TabDataMemberMentionPreparation>(
    djangoResult.stdout,
    "@@E2E@@",
  );
  if (!prepared.auth) {
    throw new Error("tabdata.member-mention prepare output missing team auth payload.");
  }
  const authPayload = prepared.auth;
  await saveElectronAuthPayload(context, authPayload, "tabdata-member-mention");
  const selection = await readElectronSelectionAfterAuthBootstrap(context, authPayload);
  await context.writeJson("snapshots/tabdata-member-mention-electron-selection.json", selection);

  const summary: TabDataMemberMentionPreparation = {
    ...prepared,
    auth: undefined,
    source: "electron-e2e-team-auth",
  };
  await context.writeJson("snapshots/tabdata-member-mention-preparation.json", summary);
  return summary;
}
