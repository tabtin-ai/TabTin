import type { RunContext, StepResult } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "../fixtures/electron-local-auth";
import type { FileDragMoveBetweenFoldersPreparation } from "../fixtures/prepare-file-drag-move-between-folders";
import { cdpClickByExpression, cdpDragBetweenExpressions } from "./real-user-input";

type RendererEvidence = {
  ready?: boolean;
  sourceFolderVisible?: boolean;
  targetFolderVisible?: boolean;
  fileVisible?: boolean;
  fileInCurrentView?: boolean;
  bodyText: string;
  visibleTargets?: string[];
};

type BackendVerification = {
  runId: string;
  contextItemId: string;
  resourceId: string;
  title: string;
  sourceCollectionId: string;
  targetCollectionId: string;
  actualCollectionId: string | null;
  movedToTarget: boolean;
  stillInSource: boolean;
};

type CdpTarget = "desktop" | "dismiss-overlay" | "cloud-drive" | "source-folder" | "target-folder" | "file-resource" | "source-breadcrumb";

function requirePreparation(context: RunContext): FileDragMoveBetweenFoldersPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof (data as { authUser?: { userId?: unknown } }).authUser?.userId !== "string" ||
    typeof (data as { space?: { id?: unknown } }).space?.id !== "string" ||
    typeof (data as { sourceFolder?: { id?: unknown; name?: unknown } }).sourceFolder?.id !== "string" ||
    typeof (data as { sourceFolder?: { id?: unknown; name?: unknown } }).sourceFolder?.name !== "string" ||
    typeof (data as { targetFolder?: { id?: unknown; name?: unknown } }).targetFolder?.id !== "string" ||
    typeof (data as { targetFolder?: { id?: unknown; name?: unknown } }).targetFolder?.name !== "string" ||
    typeof (data as { file?: { name?: unknown; contextItemId?: unknown } }).file?.name !== "string" ||
    typeof (data as { file?: { name?: unknown; contextItemId?: unknown } }).file?.contextItemId !== "string"
  ) {
    throw new Error("file.drag-move-between-folders requires prepared auth, source/target folders and file resource.");
  }
  return data as unknown as FileDragMoveBetweenFoldersPreparation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactForProgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(redactForProgress);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /body|content|markdown|text|token|input|value/i.test(key) ? "<redacted>" : redactForProgress(item);
  }
  return output;
}

function summarizeForProgress(value: unknown): string {
  const text = JSON.stringify(redactForProgress(value));
  if (!text) return "no observation yet";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function evalRendererJson<T>(
  context: RunContext,
  expression: string,
  options: { timeoutMs?: number } = {},
): T {
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 70_000,
  });
  return JSON.parse(result.stdout.trim()) as T;
}

async function pollRenderer<T>(
  context: RunContext,
  expressionFactory: () => string,
  isDone: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    last = evalRendererJson<T>(context, expressionFactory());
    if (isDone(last)) return last;
    const now = Date.now();
    if (now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      await context.reportProgress("WAIT", `${options.label} still waiting; last=${summarizeForProgress(last)}`);
    }
    await sleep(options.intervalMs);
  }
  throw new Error(`Timed out waiting for ${options.label}. Last value: ${JSON.stringify(last)}`);
}

function cdpTargetExpression(target: CdpTarget, prepared: FileDragMoveBetweenFoldersPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const target = ${JSON.stringify(target)};
  const textOf = (el) => [
    el.getAttribute?.('aria-label') || '',
    el.getAttribute?.('title') || '',
    el.innerText || '',
    el.textContent || '',
  ].join(' ').replace(/\\s+/g, ' ').trim();
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const center = (el, options = {}) => {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(options.preferTitleCell ? Math.min(rect.left + 80, rect.left + rect.width / 2) : rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      label: textOf(el).slice(0, 180),
      tag: el.tagName,
      role: el.getAttribute?.('role') || '',
      draggable: el.getAttribute?.('draggable') || '',
    };
  };
  const all = (selector) => Array.from(document.querySelectorAll(selector)).filter(isVisible);
  const matchButton = (pattern) => all('button,[role="button"],a').find((item) => pattern.test(textOf(item)));
  if (target === 'dismiss-overlay') {
    const el = matchButton(/知道了|Got it|OK/i);
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'desktop') {
    const el = matchButton(/桌面|Desktop/i);
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'cloud-drive') {
    const candidates = all('button,[role="button"],a').filter((item) => {
      const text = textOf(item);
      return /云盘|Cloud Drive/i.test(text) && !/取消置顶|置顶|Unpin|Pin/i.test(text);
    });
    const mainAreaCandidate = candidates.find((item) => item.getBoundingClientRect().left > 300);
    const el = mainAreaCandidate || candidates[0];
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'source-folder' || target === 'target-folder' || target === 'file-resource') {
    const label = target === 'source-folder'
      ? prepared.sourceFolder.name
      : target === 'target-folder'
        ? prepared.targetFolder.name
        : prepared.file.name;
    const rows = all('[role="button"],button,a,[draggable="true"]').filter((item) => textOf(item).includes(label));
    const draggable = rows.find((item) => item.getAttribute?.('draggable') === 'true');
    const el = draggable || rows[0];
    if (el) return JSON.stringify(center(el, { preferTitleCell: true }));
  }
  if (target === 'source-breadcrumb') {
    const rows = all('button,[role="button"],a').filter((item) => textOf(item).includes(prepared.sourceFolder.name));
    const el = rows[0];
    if (el) return JSON.stringify(center(el));
  }
  return JSON.stringify({
    error: 'target not found',
    target,
    bodyText: (document.body.innerText || '').slice(0, 6000),
    visible: all('button,[role="button"],a,[draggable="true"]').slice(0, 120).map((item) => textOf(item).slice(0, 160)),
  });
})()
`;
}

function cloudDrivePageReadyExpression(): string {
  return `
(() => {
  const bodyText = document.body.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button,[role="button"],a'))
    .map((item) => [
      item.getAttribute?.('aria-label') || '',
      item.getAttribute?.('title') || '',
      item.innerText || '',
      item.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim());
  return JSON.stringify({
    ready: (
      (bodyText.includes('集中管理团队内的文档') || bodyText.includes('Cloud Drive')) &&
      (buttons.some((text) => /新建资源|New Resource|New resource/i.test(text)) || buttons.some((text) => /分享给我|Shared with me/i.test(text)))
    ),
    bodyText: bodyText.slice(0, 5000),
    visibleTargets: buttons.slice(0, 100),
  });
})()
`;
}

function cloudDriveBootstrapExpression(
  prepared: FileDragMoveBetweenFoldersPreparation,
  authPayload: E2eAuthPayload,
): string {
  const authUserId = String(authPayload.userInfo.id ?? "");
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const authPayload = ${JSON.stringify({
    userInfo: { id: authUserId },
  })};
  const userId = authPayload.userInfo.id;
  const organizationId = prepared.organization.id;
  if (!userId || !organizationId) {
    throw new Error('cloud drive bootstrap requires auth.userInfo.id and organization.id');
  }
  const scopeKey = \`desktop:organization:\${organizationId}:user:\${userId}\`;
  const tabKey = 'apphome:cloud-resources';
  const storageKey = 'tabtin-prefs-context-tabs';
  const raw = localStorage.getItem(storageKey);
  const persisted = raw ? JSON.parse(raw) : { state: {}, version: 0 };
  const state = persisted.state || {};
  const activeKeyBySpace = { ...(state.activeKeyBySpace || {}), [scopeKey]: tabKey };
  const displayKeyBySpace = { ...(state.displayKeyBySpace || {}), [scopeKey]: tabKey };
  const prevOrder = Array.isArray(state.tabOrderBySpace?.[scopeKey]) ? state.tabOrderBySpace[scopeKey] : [];
  const tabOrderBySpace = {
    ...(state.tabOrderBySpace || {}),
    [scopeKey]: prevOrder.includes(tabKey) ? prevOrder : [...prevOrder, tabKey],
  };
  const prevItems = state.itemsBySpace?.[scopeKey] || {};
  const itemsBySpace = {
    ...(state.itemsBySpace || {}),
    [scopeKey]: {
      ...prevItems,
      [tabKey]: {
        tabKey,
        type: 'apphome',
        id: 'cloud-resources',
        title: '云盘',
        meta: {
          appId: 'cloud-resources',
          spaceId: prepared.space.id,
        },
      },
    },
  };
  localStorage.setItem(storageKey, JSON.stringify({
    ...persisted,
    state: {
      ...state,
      activeKeyBySpace,
      displayKeyBySpace,
      tabOrderBySpace,
      itemsBySpace,
      lastActiveSubagentByParentSession: state.lastActiveSubagentByParentSession || {},
    },
  }));
  setTimeout(() => location.reload(), 300);
  return JSON.stringify({ ok: true, scopeKey, tabKey });
})()
`;
}

function folderViewEvidenceExpression(prepared: FileDragMoveBetweenFoldersPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const bodyText = document.body.innerText || '';
  const visibleTargets = Array.from(document.querySelectorAll('button,[role="button"],a,[draggable="true"]'))
    .map((item) => [
      item.getAttribute?.('aria-label') || '',
      item.getAttribute?.('title') || '',
      item.innerText || '',
      item.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 120);
  return JSON.stringify({
    ready: bodyText.includes('集中管理团队内的文档') || bodyText.includes('Cloud Drive'),
    sourceFolderVisible: bodyText.includes(prepared.sourceFolder.name),
    targetFolderVisible: bodyText.includes(prepared.targetFolder.name),
    fileVisible: bodyText.includes(prepared.file.name),
    fileInCurrentView: visibleTargets.some((text) => text.includes(prepared.file.name)),
    bodyText: bodyText.slice(0, 8000),
    visibleTargets,
  });
})()
`;
}

async function cdpClick(
  context: RunContext,
  artifactName: string,
  target: CdpTarget,
  prepared: FileDragMoveBetweenFoldersPreparation,
): Promise<void> {
  await cdpClickByExpression(context, artifactName, cdpTargetExpression(target, prepared), {
    targetLabel: target,
  });
}

async function dismissKnownOverlayIfPresent(
  context: RunContext,
  prepared: FileDragMoveBetweenFoldersPreparation,
  logPrefix: string,
): Promise<void> {
  try {
    await cdpClick(context, `${logPrefix}-dismiss-overlay-cdp`, "dismiss-overlay", prepared);
    await sleep(300);
  } catch {
    // No onboarding/help overlay is present. Continue with the visible user path.
  }
}

async function openCloudDriveByClicks(
  context: RunContext,
  prepared: FileDragMoveBetweenFoldersPreparation,
  authPayload: E2eAuthPayload,
): Promise<void> {
  try {
    await pollRenderer<RendererEvidence>(
      context,
      cloudDrivePageReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 2000, intervalMs: 1000, label: "Cloud Drive already open" },
    );
    return;
  } catch {
    // Continue with real clicks below.
  }

  await dismissKnownOverlayIfPresent(context, prepared, "file-drag-move");
  await cdpClick(context, "file-drag-move-click-cloud-drive-cdp", "cloud-drive", prepared);
  try {
    await pollRenderer<RendererEvidence>(
      context,
      cloudDrivePageReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 12_000, intervalMs: 1500, label: "Cloud Drive page" },
    );
    return;
  } catch {
    try {
      await cdpClick(context, "file-drag-move-click-desktop-cdp", "desktop", prepared);
      await sleep(1000);
      await dismissKnownOverlayIfPresent(context, prepared, "file-drag-move-after-desktop");
      await cdpClick(context, "file-drag-move-click-cloud-drive-after-desktop-cdp", "cloud-drive", prepared);
      await pollRenderer<RendererEvidence>(
        context,
        cloudDrivePageReadyExpression,
        (value) => Boolean(value.ready),
        { timeoutMs: 30_000, intervalMs: 1500, label: "Cloud Drive page after desktop" },
      );
    } catch {
      await context.reportProgress("FILE", "Cloud Drive click path did not switch page; bootstrap apphome tab for navigation only");
      const bootstrap = evalRendererJson<{ ok: boolean; scopeKey: string; tabKey: string }>(
        context,
        cloudDriveBootstrapExpression(prepared, authPayload),
        { timeoutMs: 30_000 },
      );
      await context.writeJson("snapshots/file-drag-move-cloud-bootstrap.json", bootstrap);
      await sleep(5000);
      await pollRenderer<RendererEvidence>(
        context,
        cloudDrivePageReadyExpression,
        (value) => Boolean(value.ready),
        { timeoutMs: 30_000, intervalMs: 1500, label: "Cloud Drive page after apphome bootstrap" },
      );
    }
  }
}

async function runVerifyDjango(
  context: RunContext,
  prepared: FileDragMoveBetweenFoldersPreparation,
): Promise<BackendVerification> {
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
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "verify",
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_CONTEXT_ITEM_ID: prepared.file.contextItemId,
        TABTIN_E2E_SOURCE_COLLECTION_ID: prepared.sourceFolder.id,
        TABTIN_E2E_TARGET_COLLECTION_ID: prepared.targetFolder.id,
      },
    },
  );
  await context.writeText("logs/file-drag-move-between-folders-verify-django.log", result.stdout);
  return parseJsonSentinel<BackendVerification>(result.stdout, "@@E2E@@");
}

async function runAuthDjango(
  context: RunContext,
  prepared: FileDragMoveBetweenFoldersPreparation,
): Promise<E2eAuthPayload> {
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
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "auth",
        TABTIN_E2E_RUN_ID: prepared.runId,
      },
    },
  );
  await context.writeText(
    "logs/file-drag-move-between-folders-auth-django.log",
    result.stdout
      .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
      .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"'),
  );
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, "@@E2E@@");
}

export async function runFileDragMoveBetweenFoldersCase(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);
  artifacts.push(await context.writeJson("snapshots/file-drag-move-between-folders-action-input.json", {
    runId: context.runId,
    scenarioId: context.scenarioId,
    prepared,
    requiredUiAction: "real mouse drag from prepared.file.contextItemId resource row/card to prepared.targetFolder row/card",
    expectedUiEvidence: {
      sourceFolderNoLongerShowsFile: prepared.file?.name,
      targetFolderShowsFile: prepared.file?.name,
    },
    expectedPersistenceEvidence: {
      collectionIdAfterMove: prepared.file.expectedCollectionIdAfterMove,
    },
  }));

  await context.reportProgress("FILE", "bootstrap local auth and open Cloud Drive");
  const authPayload = await runAuthDjango(context, prepared);
  await saveElectronAuthPayload(context, authPayload, "file-drag-move-between-folders");
  await openCloudDriveByClicks(context, prepared, authPayload);

  await context.reportProgress("FILE", "open source folder by real click");
  const rootView = await pollRenderer<RendererEvidence>(
    context,
    () => folderViewEvidenceExpression(prepared),
    (value) => Boolean(value.ready && value.sourceFolderVisible),
    { timeoutMs: 45_000, intervalMs: 2_000, label: "source folder visible at cloud root" },
  );
  artifacts.push(await context.writeJson("snapshots/file-drag-move-root-view.json", rootView));
  await cdpClick(context, "file-drag-move-click-source-folder-cdp", "source-folder", prepared);

  const sourceBefore = await pollRenderer<RendererEvidence>(
    context,
    () => folderViewEvidenceExpression(prepared),
    (value) => Boolean(value.ready && value.targetFolderVisible && value.fileInCurrentView),
    { timeoutMs: 45_000, intervalMs: 2_000, label: "source folder with target folder and file" },
  );
  artifacts.push(await context.writeJson("snapshots/file-drag-move-source-before.json", sourceBefore));

  await context.reportProgress("FILE", "drag file resource into target folder by CDP mouse");
  await cdpDragBetweenExpressions(
    context,
    "file-drag-move-drag-file-to-target-cdp",
    cdpTargetExpression("file-resource", prepared),
    cdpTargetExpression("target-folder", prepared),
    {
      targetLabel: "file resource to target folder",
      steps: 18,
      delayMs: 16,
      holdMs: 120,
      timeoutMs: 45_000,
      dragData: {
        items: [
          {
            mimeType: "application/x-collection-item",
            data: JSON.stringify({
              id: prepared.file.contextItemId,
              collection_id: prepared.sourceFolder.id,
              title: prepared.file.name,
              resource_id: prepared.file.resourceId,
            }),
            title: prepared.file.name,
          },
        ],
        dragOperationsMask: 16,
      },
    },
  );

  const sourceAfter = await pollRenderer<RendererEvidence>(
    context,
    () => folderViewEvidenceExpression(prepared),
    (value) => Boolean(value.ready && value.targetFolderVisible && !value.fileInCurrentView),
    { timeoutMs: 60_000, intervalMs: 2_000, label: "file removed from source folder UI" },
  );
  artifacts.push(await context.writeJson("snapshots/file-drag-move-source-after.json", sourceAfter));

  await context.reportProgress("FILE", "open target folder and assert moved file visible");
  await cdpClick(context, "file-drag-move-click-target-folder-cdp", "target-folder", prepared);
  const targetAfter = await pollRenderer<RendererEvidence>(
    context,
    () => folderViewEvidenceExpression(prepared),
    (value) => Boolean(value.ready && value.fileInCurrentView),
    { timeoutMs: 45_000, intervalMs: 2_000, label: "file visible in target folder UI" },
  );
  artifacts.push(await context.writeJson("snapshots/file-drag-move-target-after.json", targetAfter));

  await context.reportProgress("FILE", "return to source folder and assert moved file is absent");
  await cdpClick(context, "file-drag-move-click-source-breadcrumb-cdp", "source-breadcrumb", prepared);
  const sourceFinal = await pollRenderer<RendererEvidence>(
    context,
    () => folderViewEvidenceExpression(prepared),
    (value) => Boolean(value.ready && value.targetFolderVisible && !value.fileInCurrentView),
    { timeoutMs: 45_000, intervalMs: 2_000, label: "file still absent after returning to source folder" },
  );
  artifacts.push(await context.writeJson("snapshots/file-drag-move-source-final.json", sourceFinal));

  await context.reportProgress("FILE", "verify ContextItem collection_id moved to target folder");
  const verify = await runVerifyDjango(context, prepared);
  artifacts.push(await context.writeJson("snapshots/file-drag-move-backend-verify.json", verify));
  if (
    !verify.movedToTarget ||
    verify.stillInSource ||
    verify.resourceId !== prepared.file.resourceId ||
    verify.title !== prepared.file.name
  ) {
    return {
      id: "file.drag-move-between-folders.drag-file-into-target-folder",
      title: "通过真实拖拽把源文件夹中的文件移动到目标文件夹并断言 UI 与持久化位置",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message: `file.drag-move-between-folders failed: backend verification mismatch ${JSON.stringify({
        actualCollectionId: verify.actualCollectionId,
        expectedCollectionId: verify.targetCollectionId,
        resourceIdMatched: verify.resourceId === prepared.file.resourceId,
        titleMatched: verify.title === prepared.file.name,
        stillInSource: verify.stillInSource,
      })}.`,
      artifacts,
    };
  }

  return {
    id: "file.drag-move-between-folders.drag-file-into-target-folder",
    title: "通过真实拖拽把源文件夹中的文件移动到目标文件夹并断言 UI 与持久化位置",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message:
      "file.drag-move-between-folders passed: user-visible CDP mouse drag moved the resource from source folder to target folder, and ContextItem.collection_id persisted the target folder.",
    artifacts,
  };
}
