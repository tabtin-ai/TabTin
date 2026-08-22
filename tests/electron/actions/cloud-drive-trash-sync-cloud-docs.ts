import { saveElectronAuthPayload, type E2eAuthPayload } from "../fixtures/electron-local-auth";
import type { CloudDriveTrashSyncCloudDocsPreparation } from "../fixtures/prepare-cloud-drive-trash-sync-cloud-docs";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import type { RunContext, StepResult } from "../runner/types";
import {
  cdpClickByExpression,
  cdpRightClickByExpression,
} from "./real-user-input";

type RendererEvidence = {
  ready?: boolean;
  bodyText?: string;
  visibleTargets?: string[];
  titleVisible?: boolean;
  docVisible?: boolean;
  tableVisible?: boolean;
};

type BackendVerification = {
  runId: string;
  documentTrashed: boolean;
  tableTrashed: boolean;
  docContextTrashed: boolean;
  tableContextTrashed: boolean;
  getTableBlocked: boolean;
  getDocumentBlocked: boolean;
  ok: boolean;
  getTableError?: string;
  getDocumentError?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requirePreparation(context: RunContext): CloudDriveTrashSyncCloudDocsPreparation {
  const prepared = context.preparedData as Partial<CloudDriveTrashSyncCloudDocsPreparation>;
  if (
    !prepared?.prepared
    || !prepared.organization?.id
    || !prepared.space?.id
    || !prepared.document?.id
    || !prepared.table?.id
  ) {
    throw new Error("cloud-drive.trash-sync-cloud-docs missing preparation payload");
  }
  return prepared as CloudDriveTrashSyncCloudDocsPreparation;
}

function evalRendererJson<T>(
  context: RunContext,
  expression: string,
  options: { timeoutMs?: number } = {},
): T {
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  return JSON.parse(result.stdout.trim()) as T;
}

async function pollRenderer<T>(
  context: RunContext,
  expressionFactory: string | (() => string),
  predicate: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < options.timeoutMs) {
    const expression = typeof expressionFactory === "function"
      ? expressionFactory()
      : expressionFactory;
    last = evalRendererJson<T>(context, expression, { timeoutMs: 15_000 });
    if (predicate(last)) return last;
    if (Date.now() - started > 10_000) {
      await context.reportProgress("WAIT", `still waiting: ${options.label}`);
    }
    await sleep(options.intervalMs);
  }
  throw new Error(`${options.label} timed out: ${JSON.stringify(last)}`);
}

function titlePointExpression(title: string): string {
  return `
(() => {
  const needle = ${JSON.stringify(title)};
  // 优先点主列表行（role=button / tr），避免点到左侧知识树或缺 handler 的纯文本节点
  const preferred = Array.from(document.querySelectorAll('[role="button"],tr,[data-resource-id],button'));
  const fallback = Array.from(document.querySelectorAll('a,[draggable="true"],li,span,div'));
  const nodes = preferred.concat(fallback);
  let best = null;
  for (const node of nodes) {
    if (node.getAttribute?.('aria-busy') === 'true') continue;
    const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text || !text.includes(needle)) continue;
    if (/Deleting|删除中/.test(text)) continue;
    // 避免点到整页大容器：标题行通常较短，且不应包含另一条验收资源
    if (text.length > needle.length + 120) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 12 || rect.width > 1100 || rect.height > 120) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const tag = (node.tagName || '').toLowerCase();
    const role = node.getAttribute?.('role') || '';
    const isRow = role === 'button' || tag === 'tr' || node.hasAttribute?.('data-resource-id');
    // 优先主列表（偏右）与真正行容器
    const preferMainList = rect.left >= 360 ? 500 : (rect.left >= 280 ? 200 : 0);
    const preferRow = isRow ? 300 : 0;
    const exactBonus = text === needle || text.startsWith(needle) ? 120 : 0;
    const score = preferMainList + preferRow + exactBonus
      + (1000 - text.length) + (200 - Math.min(rect.height, 200)) + Math.min(rect.width, 400) / 10;
    if (!best || score > best.score) {
      best = {
        score,
        x: Math.round(rect.left + Math.min(Math.max(rect.width * 0.35, 48), 220)),
        y: Math.round(rect.top + rect.height / 2),
        text: text.slice(0, 200),
        left: Math.round(rect.left),
        row: isRow,
      };
    }
  }
  if (!best) {
    return JSON.stringify({ error: 'title not found', needle, bodyText: (document.body.innerText || '').slice(0, 4000) });
  }
  return JSON.stringify({
    x: best.x, y: best.y, text: best.text, left: best.left, row: best.row,
  });
})()
`;
}

function menuItemPointExpression(labels: string[]): string {
  return `
(() => {
  const labels = ${JSON.stringify(labels)};
  const selectors = [
    '[role="menuitem"]',
    '[data-radix-collection-item]',
    '[data-radix-menu-content] button',
    '[data-radix-dropdown-menu-content] button',
    '[data-radix-context-menu-content] button',
    'button',
    '[role="button"]',
  ];
  const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
  const visibleMenus = [];
  for (const node of nodes) {
    const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 40) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 12 || rect.width > 420) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    visibleMenus.push(text);
    if (!labels.some((label) => text === label || text.startsWith(label))) continue;
    return JSON.stringify({
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      text,
    });
  }
  return JSON.stringify({
    error: 'menu item not found',
    labels,
    visibleMenus: visibleMenus.slice(0, 40),
    bodyText: (document.body.innerText || '').slice(0, 4000),
  });
})()
`;
}

function confirmDeletePointExpression(): string {
  return `
(() => {
  const labels = ['Delete', '删除'];
  // ConfirmDialog 确认钮通常在 dialog/alertdialog 内
  const roots = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-state="open"]'));
  const pools = roots.length > 0 ? roots : [document.body];
  for (const root of pools) {
    const nodes = Array.from(root.querySelectorAll('button,[role="button"]'));
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!labels.some((label) => text === label)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 16) continue;
      return JSON.stringify({
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        text,
      });
    }
  }
  return JSON.stringify({ error: 'confirm delete button not found', bodyText: (document.body.innerText || '').slice(0, 4000) });
})()
`;
}

function cloudDriveReadyExpression(): string {
  return `
(() => {
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    ready: (
      bodyText.includes('集中管理组织内的文档')
      || bodyText.includes('集中管理团队内的文档')
      || bodyText.includes('Cloud Drive')
      || (bodyText.includes('云文档') && bodyText.includes('新建'))
    ),
    bodyText: bodyText.slice(0, 5000),
  });
})()
`;
}

function resourceVisibilityExpression(prepared: CloudDriveTrashSyncCloudDocsPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify({
    docTitle: prepared.document.title,
    tableName: prepared.table.name,
  })};
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    ready: true,
    docVisible: bodyText.includes(prepared.docTitle),
    tableVisible: bodyText.includes(prepared.tableName),
    bodyText: bodyText.slice(0, 8000),
  });
})()
`;
}

function railTargetExpression(labelHints: string[]): string {
  return `
(() => {
  const hints = ${JSON.stringify(labelHints)};
  const nodes = Array.from(document.querySelectorAll('button,[role="button"],a,[data-rail],nav *'));
  for (const node of nodes) {
    const text = [
      node.getAttribute?.('aria-label') || '',
      node.getAttribute?.('title') || '',
      node.innerText || '',
      node.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    if (!hints.some((hint) => text.includes(hint))) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    return JSON.stringify({
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      text,
    });
  }
  return JSON.stringify({ error: 'rail target not found', hints, bodyText: (document.body.innerText || '').slice(0, 4000) });
})()
`;
}

function cloudDriveBootstrapExpression(
  prepared: CloudDriveTrashSyncCloudDocsPreparation,
  authPayload: E2eAuthPayload,
): string {
  const authUserId = String(authPayload.userInfo.id ?? "");
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const userId = ${JSON.stringify(authUserId)};
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

async function runAuthDjango(
  context: RunContext,
  prepared: CloudDriveTrashSyncCloudDocsPreparation,
): Promise<E2eAuthPayload> {
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
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "auth",
        TABTIN_E2E_RUN_ID: prepared.runId,
      },
    },
  );
  await context.writeText(
    "logs/cloud-drive-trash-sync-cloud-docs-auth-django.log",
    result.stdout
      .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
      .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"'),
  );
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, "@@E2E@@");
}

async function runVerifyDjango(
  context: RunContext,
  prepared: CloudDriveTrashSyncCloudDocsPreparation,
): Promise<BackendVerification> {
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
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "verify",
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_USER_ID: prepared.authUser.userId,
        TABTIN_E2E_DOCUMENT_ID: prepared.document.id,
        TABTIN_E2E_TABLE_ID: prepared.table.id,
        TABTIN_E2E_DOC_CONTEXT_ITEM_ID: prepared.document.contextItemId,
        TABTIN_E2E_TABLE_CONTEXT_ITEM_ID: prepared.table.contextItemId,
      },
    },
  );
  await context.writeText("logs/cloud-drive-trash-sync-cloud-docs-verify-django.log", result.stdout);
  return parseJsonSentinel<BackendVerification>(result.stdout, "@@E2E@@");
}

async function openCloudDrive(
  context: RunContext,
  prepared: CloudDriveTrashSyncCloudDocsPreparation,
  authPayload: E2eAuthPayload,
): Promise<void> {
  try {
    await pollRenderer<RendererEvidence>(
      context,
      cloudDriveReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 2_000, intervalMs: 500, label: "Cloud Drive already open" },
    );
    return;
  } catch {
    // fall through
  }

  try {
    await cdpClickByExpression(
      context,
      "cloud-trash-sync-click-cloud-drive",
      railTargetExpression(["云盘", "Cloud Drive", "cloud-resources"]),
      { targetLabel: "cloud-drive rail", timeoutMs: 15_000 },
    );
    await pollRenderer<RendererEvidence>(
      context,
      cloudDriveReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 20_000, intervalMs: 1_500, label: "Cloud Drive after rail click" },
    );
    return;
  } catch {
    await context.reportProgress("FILE", "Cloud Drive click path failed; bootstrap apphome tab");
    evalRendererJson(
      context,
      cloudDriveBootstrapExpression(prepared, authPayload),
      { timeoutMs: 30_000 },
    );
    await sleep(5_000);
    await pollRenderer<RendererEvidence>(
      context,
      cloudDriveReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 30_000, intervalMs: 1_500, label: "Cloud Drive after bootstrap" },
    );
  }
}

async function dismissTransientUi(context: RunContext): Promise<void> {
  // 关掉残留菜单 / 对话框，避免下一次右键被吞
  try {
    runCommand("node", ["scripts/cdp-input.mjs", "key", "Escape"], {
      cwd: context.repoRoot,
      timeoutMs: 10_000,
    });
  } catch {
    // ignore
  }
  await sleep(250);
  try {
    runCommand("node", ["scripts/cdp-input.mjs", "key", "Escape"], {
      cwd: context.repoRoot,
      timeoutMs: 10_000,
    });
  } catch {
    // ignore
  }
  await sleep(250);
}

async function trashResourceByTitle(
  context: RunContext,
  title: string,
  artifactPrefix: string,
): Promise<void> {
  await context.reportProgress("UI", `right-click trash: ${title}`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await dismissTransientUi(context);
      await cdpRightClickByExpression(
        context,
        `${artifactPrefix}-right-click-a${attempt}`,
        titlePointExpression(title),
        { targetLabel: `${title} (attempt ${attempt})`, timeoutMs: 30_000 },
      );
      await sleep(700);
      await cdpClickByExpression(
        context,
        `${artifactPrefix}-menu-delete-a${attempt}`,
        menuItemPointExpression(["Delete", "删除"]),
        { targetLabel: `Delete menu item (attempt ${attempt})`, timeoutMs: 12_000 },
      );
      await sleep(500);
      await cdpClickByExpression(
        context,
        `${artifactPrefix}-confirm-delete-a${attempt}`,
        confirmDeletePointExpression(),
        { targetLabel: `Delete confirm (attempt ${attempt})`, timeoutMs: 15_000 },
      );
      // 等该标题从云盘活跃列表消失，再删下一项，避免删除中态吞掉右键
      await pollRenderer<{ visible: boolean }>(
        context,
        `
(() => {
  const needle = ${JSON.stringify(title)};
  const bodyText = document.body.innerText || '';
  const busy = /Deleting|删除中/.test(bodyText);
  return JSON.stringify({ visible: bodyText.includes(needle) || busy });
})()
`,
        (value) => !value.visible,
        {
          timeoutMs: 45_000,
          intervalMs: 1_000,
          label: `wait gone after trash: ${title}`,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      await context.reportProgress(
        "UI",
        `trash attempt ${attempt} failed for ${title}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await dismissTransientUi(context);
      await sleep(800);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`trashResourceByTitle failed: ${String(lastError)}`);
}

async function openCloudDocs(context: RunContext): Promise<void> {
  await cdpClickByExpression(
    context,
    "cloud-trash-sync-click-cloud-docs",
    railTargetExpression(["云文档", "Cloud Docs", "cloud-docs", "知识库"]),
    { targetLabel: "cloud-docs rail", timeoutMs: 20_000 },
  );
  await sleep(1_000);
}

export async function runCloudDriveTrashSyncCloudDocsCase(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);
  artifacts.push(await context.writeJson("snapshots/cloud-drive-trash-sync-cloud-docs-action-input.json", {
    runId: context.runId,
    scenarioId: context.scenarioId,
    prepared,
  }));

  await context.reportProgress("AUTH", "bootstrap local auth and open Cloud Drive");
  const authPayload = await runAuthDjango(context, prepared);
  await saveElectronAuthPayload(context, authPayload, "cloud-drive-trash-sync-cloud-docs");
  await openCloudDrive(context, prepared, authPayload);

  const before = await pollRenderer<RendererEvidence>(
    context,
    () => resourceVisibilityExpression(prepared),
    (value) => Boolean(value.docVisible && value.tableVisible),
    { timeoutMs: 60_000, intervalMs: 2_000, label: "prepared doc/table visible in cloud drive" },
  );
  artifacts.push(await context.writeJson("snapshots/cloud-trash-sync-before.json", before));

  await trashResourceByTitle(context, prepared.document.title, "cloud-trash-sync-doc");
  await trashResourceByTitle(context, prepared.table.name, "cloud-trash-sync-table");

  const afterDrive = await pollRenderer<RendererEvidence>(
    context,
    () => resourceVisibilityExpression(prepared),
    (value) => Boolean(!value.docVisible && !value.tableVisible),
    { timeoutMs: 45_000, intervalMs: 1_500, label: "doc/table gone from cloud drive list" },
  );
  artifacts.push(await context.writeJson("snapshots/cloud-trash-sync-after-drive.json", afterDrive));

  await context.reportProgress("UI", "switch to cloud docs and assert list converged");
  await openCloudDocs(context);
  const afterDocs = await pollRenderer<RendererEvidence>(
    context,
    () => resourceVisibilityExpression(prepared),
    (value) => Boolean(!value.docVisible && !value.tableVisible),
    { timeoutMs: 45_000, intervalMs: 1_500, label: "doc/table gone from cloud docs list" },
  );
  artifacts.push(await context.writeJson("snapshots/cloud-trash-sync-after-docs.json", afterDocs));

  await context.reportProgress("DB", "verify source + ContextItem trash and active read guards");
  const verification = await runVerifyDjango(context, prepared);
  artifacts.push(await context.writeJson("snapshots/cloud-trash-sync-verify.json", verification));
  if (!verification.ok) {
    throw new Error(`backend trash convergence failed: ${JSON.stringify(verification)}`);
  }

  return {
    id: "cloud-drive.trash-sync-cloud-docs.main",
    title: "云盘删除文档/表格后云文档列表立即消失，并完成回收站状态断言",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message: "Cloud Drive trash removed doc/table from both lists; Django trash + active-read guards OK.",
    artifacts,
  };
}
