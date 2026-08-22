import type { RunContext, StepResult } from '../runner/types';
import {
  parseJsonSentinel,
  resolvePythonCommand,
  runCommand,
} from '../runner/process';
import {
  saveElectronAuthPayload,
  type E2eAuthPayload,
} from '../fixtures/electron-local-auth';
import type { TabdataEmbeddedCollabParentPermissionPreparation } from '../fixtures/prepare-tabdata-embedded-collab-parent-permission';
import {
  cdpClickByExpression,
  cdpDoubleClickByExpression,
  cdpInsertText,
  cdpPressKey,
} from './real-user-input';

type PermissionVerification = {
  matchingRecordId: string | null;
  recordValueMatched: boolean;
  activeRecordCount: number;
  directAccess: boolean;
  inheritedAccess: boolean;
  forgedAccess: boolean;
  explicitTablePermissionCount: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evalRenderer<T>(context: RunContext, expression: string): T {
  const result = runCommand('node', ['scripts/cdp-eval.mjs', expression], {
    cwd: context.repoRoot,
    timeoutMs: 30_000,
  });
  return JSON.parse(result.stdout.trim()) as T;
}

async function pollRenderer<T>(
  context: RunContext,
  expression: string,
  done: (value: T) => boolean,
  label: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = evalRenderer<T>(context, expression);
    if (done(last)) return last;
    await sleep(1_500);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function redactAuth(stdout: string): string {
  return stdout
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"');
}

function runAuth(
  context: RunContext,
  prepared: TabdataEmbeddedCollabParentPermissionPreparation,
  input: {
    userId: string;
    spaceId: string;
    role: 'owner' | 'editor';
    logName: string;
  },
): E2eAuthPayload {
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
        TABTIN_E2E_MODE: 'auth',
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_AUTH_USER_ID: input.userId,
        TABTIN_E2E_ORGANIZATION_ID: prepared.organizationId,
        TABTIN_E2E_SPACE_ID: input.spaceId,
        TABTIN_E2E_ROLE: input.role,
      },
    },
  );
  void context.writeText(
    `logs/${input.logName}.log`,
    redactAuth(result.stdout),
  );
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, '@@E2E@@');
}

function visibleTargetExpression(
  kind: 'cloud-drive' | 'shared-with-me' | 'document',
  title = '',
): string {
  return `
(() => {
  const kind = ${JSON.stringify(kind)};
  const title = ${JSON.stringify(title)};
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textOf = (el) => [el.getAttribute?.('aria-label') || '', el.getAttribute?.('title') || '', el.innerText || '', el.textContent || ''].join(' ').replace(/\\s+/g, ' ').trim();
  const candidates = Array.from(document.querySelectorAll('button,[role="button"],a,[role="row"],[role="treeitem"]')).filter(visible);
  let target = null;
  if (kind === 'cloud-drive') target = candidates.find((el) => /云盘|云文档|Cloud Drive/i.test(textOf(el)) && !/置顶|Pin/i.test(textOf(el)));
  if (kind === 'shared-with-me') target = candidates.find((el) => /分享给我|Shared with me/i.test(textOf(el)));
  if (kind === 'document') target = candidates.find((el) => textOf(el).includes(title));
  if (!target) return JSON.stringify({ error: 'target not found', kind, title, bodyText: (document.body.innerText || '').slice(0, 6000) });
  target.scrollIntoView?.({ block: 'center', inline: 'center' });
  const rect = target.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), label: textOf(target).slice(0, 200) });
})()
`;
}

function documentReadyExpression(
  prepared: TabdataEmbeddedCollabParentPermissionPreparation,
): string {
  return `
(() => {
  const bodyText = document.body.innerText || '';
  const stages = Array.from(document.querySelectorAll('[data-t-grid-stage]')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 200 && rect.height > 80;
  });
  return JSON.stringify({
    documentVisible: bodyText.includes(${JSON.stringify(prepared.documentTitle)}),
    tableVisible: bodyText.includes(${JSON.stringify(prepared.tableTitle)}),
    gridVisible: stages.length > 0,
    bodyText: bodyText.slice(0, 6000),
  });
})()
`;
}

function gridCellExpression(): string {
  return `
(() => {
  const stages = Array.from(document.querySelectorAll('[data-t-grid-stage]')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 200 && rect.height > 80;
  }).sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  });
  const stage = stages[0];
  if (!stage) return JSON.stringify({ error: 'embedded grid stage not found' });
  const rect = stage.getBoundingClientRect();
  return JSON.stringify({
    x: Math.round(rect.left + Math.min(150, rect.width * 0.25)),
    y: Math.round(rect.top + Math.min(72, rect.height * 0.22)),
    label: 'first embedded table record cell',
  });
})()
`;
}

function editorValueExpression(): string {
  return `
(() => {
  const overlay = document.querySelector('[data-grid-overlay="cell-editor"]');
  const input = overlay?.querySelector('input,textarea,[contenteditable="true"]') || document.activeElement;
  const value = input && ('value' in input ? input.value : input.textContent || '');
  return JSON.stringify({ editorVisible: Boolean(overlay), value: value || '' });
})()
`;
}

async function openDocumentFromCloudDrive(
  context: RunContext,
  prepared: TabdataEmbeddedCollabParentPermissionPreparation,
  sharedWithMe: boolean,
  prefix: string,
): Promise<void> {
  await pollRenderer<{ error?: string }>(
    context,
    visibleTargetExpression('cloud-drive'),
    (value) => !value.error,
    `${prefix} Cloud Drive entry`,
  );
  await cdpClickByExpression(
    context,
    `${prefix}-cloud-drive`,
    visibleTargetExpression('cloud-drive'),
    {
      targetLabel: '云盘',
    },
  );
  await sleep(1_500);
  if (sharedWithMe) {
    await pollRenderer<{ error?: string }>(
      context,
      visibleTargetExpression('shared-with-me'),
      (value) => !value.error,
      `${prefix} shared-with-me entry`,
    );
    await cdpClickByExpression(
      context,
      `${prefix}-shared-with-me`,
      visibleTargetExpression('shared-with-me'),
      {
        targetLabel: '分享给我',
      },
    );
    await sleep(1_500);
  }
  await pollRenderer<{ error?: string }>(
    context,
    visibleTargetExpression('document', prepared.documentTitle),
    (value) => !value.error,
    `${prefix} parent document row`,
  );
  await cdpClickByExpression(
    context,
    `${prefix}-document`,
    visibleTargetExpression('document', prepared.documentTitle),
    { targetLabel: prepared.documentTitle },
  );
  await pollRenderer<{
    documentVisible: boolean;
    tableVisible: boolean;
    gridVisible: boolean;
  }>(
    context,
    documentReadyExpression(prepared),
    (value) => value.documentVisible && value.tableVisible && value.gridVisible,
    `${prefix} 父文档与内嵌表格加载`,
  );
}

function verifyBackend(
  context: RunContext,
  prepared: TabdataEmbeddedCollabParentPermissionPreparation,
): PermissionVerification {
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
        TABTIN_E2E_MODE: 'verify',
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_COLLABORATOR_USER_ID: prepared.collaboratorUserId,
        TABTIN_E2E_ORGANIZATION_ID: prepared.organizationId,
        TABTIN_E2E_TABLE_ID: prepared.tableId,
        TABTIN_E2E_DOCUMENT_ID: prepared.documentId,
        TABTIN_E2E_UNRELATED_DOCUMENT_ID: prepared.unrelatedDocumentId,
        TABTIN_E2E_FIELD_ID: prepared.fieldId,
        TABTIN_E2E_RECORD_ID: prepared.recordId,
        TABTIN_E2E_EXPECTED_VALUE: prepared.editedValue,
      },
    },
  );
  return parseJsonSentinel<PermissionVerification>(result.stdout, '@@E2E@@');
}

export async function runTabdataEmbeddedCollabParentPermissionCase(
  context: RunContext,
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared =
    context.preparedData as unknown as TabdataEmbeddedCollabParentPermissionPreparation;
  try {
    const ownerAuth = runAuth(context, prepared, {
      userId: prepared.ownerUserId,
      spaceId: prepared.ownerSpaceId,
      role: 'owner',
      logName: 'tabdata-embedded-parent-owner-auth',
    });
    await saveElectronAuthPayload(
      context,
      ownerAuth,
      'tabdata-embedded-parent-owner',
    );
    await openDocumentFromCloudDrive(context, prepared, false, 'owner');
    artifacts.push(
      await context.writeJson(
        'snapshots/tabdata-embedded-parent-owner-opened.json',
        { documentId: prepared.documentId, opened: true },
      ),
    );

    const collaboratorAuth = runAuth(context, prepared, {
      userId: prepared.collaboratorUserId,
      spaceId: prepared.navigationSpaceId,
      role: 'editor',
      logName: 'tabdata-embedded-parent-collaborator-auth',
    });
    await saveElectronAuthPayload(
      context,
      collaboratorAuth,
      'tabdata-embedded-parent-collaborator',
    );
    await openDocumentFromCloudDrive(context, prepared, true, 'collaborator');

    await cdpDoubleClickByExpression(
      context,
      'collaborator-double-click-cell',
      gridCellExpression(),
      {
        targetLabel: '内嵌表格第一条记录',
      },
    );
    await cdpPressKey(context, 'collaborator-select-cell-text', 'Control+A');
    await cdpInsertText(
      context,
      'collaborator-type-cell-text',
      prepared.editedValue,
    );
    const editorBeforeSubmit = evalRenderer<{
      editorVisible: boolean;
      value: string;
    }>(context, editorValueExpression());
    artifacts.push(
      await context.writeJson(
        'snapshots/tabdata-embedded-parent-editor-before-submit.json',
        editorBeforeSubmit,
      ),
    );
    if (!editorBeforeSubmit.value.includes(prepared.editedValue)) {
      throw new Error(
        `CDP input did not reach the visible cell editor: ${JSON.stringify(editorBeforeSubmit)}`,
      );
    }
    await cdpPressKey(context, 'collaborator-submit-cell-edit', 'Enter');
    await sleep(4_000);

    await cdpDoubleClickByExpression(
      context,
      'collaborator-reopen-cell',
      gridCellExpression(),
      {
        targetLabel: '已编辑的内嵌表格单元格',
      },
    );
    const visibleEditedCell = await pollRenderer<{
      editorVisible: boolean;
      value: string;
    }>(
      context,
      editorValueExpression(),
      (value) =>
        value.editorVisible && value.value.includes(prepared.editedValue),
      '已编辑单元格重新显示新值',
      15_000,
    );
    artifacts.push(
      await context.writeJson(
        'snapshots/tabdata-embedded-parent-visible-edited-cell.json',
        visibleEditedCell,
      ),
    );
    await cdpPressKey(context, 'collaborator-close-reopened-cell', 'Escape');

    const verification = verifyBackend(context, prepared);
    artifacts.push(
      await context.writeJson(
        'snapshots/tabdata-embedded-parent-permission-verification.json',
        verification,
      ),
    );
    const passed =
      verification.recordValueMatched &&
      !verification.directAccess &&
      verification.inheritedAccess &&
      !verification.forgedAccess &&
      verification.explicitTablePermissionCount === 0;
    if (!passed)
      throw new Error(
        `Permission verification failed: ${JSON.stringify(verification)}`,
      );

    return {
      id: 'tabdata.embedded-collab-parent-permission.main',
      title: '双账号通过 Electron 打开父文档并由协作者真实编辑内嵌表格',
      status: 'passed',
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        '拥有者与协作者均通过 Electron 打开父文档；协作者通过真实 CDP 输入编辑并持久化内嵌表格，真实父文档授权成功且伪造父文档被拒绝。',
      artifacts,
    };
  } catch (error) {
    artifacts.push(
      await context.writeJson(
        'snapshots/tabdata-embedded-parent-failure.json',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    );
    return {
      id: 'tabdata.embedded-collab-parent-permission.main',
      title: '双账号通过 Electron 打开父文档并由协作者真实编辑内嵌表格',
      status: 'failed',
      startedAt,
      endedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      artifacts,
    };
  }
}
