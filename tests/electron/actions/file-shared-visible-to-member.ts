import type { RunContext, StepResult } from "../runner/types";
import { CommandExecutionError, parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "../fixtures/electron-local-auth";
import {
  readElectronSelectionAfterAuthBootstrap,
  type FileSharedVisibleToMemberPreparation,
} from "../fixtures/prepare-file-shared-visible-to-member";
import { cdpClickByExpression, cdpInsertText } from "./real-user-input";

type SharedResource = {
  resourceType: "doc";
  documentId: string;
  title: string;
  organizationId: string;
  spaceId: string;
};

type ShareResult = {
  permission: string;
  notified: number;
  skipped: Array<{ user_id?: string; reason?: string }>;
  permissionCount: number;
};

type PreparedWithResource = FileSharedVisibleToMemberPreparation & {
  resource: SharedResource;
  share: ShareResult;
};

type CloudDriveEvidence = {
  ready: boolean;
  sharedButtonFound: boolean;
  sharedButtonPressed: boolean;
  foundTitle: boolean;
  foundBody: boolean;
  foundSharedBy: boolean;
  activeTabLooksOpened: boolean;
  activeDocumentIdMatched: boolean;
  editorLoaded: boolean;
  bodyText: string;
  visibleButtons: Array<{ text: string; ariaLabel: string; ariaPressed: string }>;
};

type SharedFileBackendVerification = {
  documentId: string;
  organizationId: string;
  viewerMemberId: string;
  sharedWithMeMatched: boolean;
  sharedWithMeItem: unknown;
  expectedMemberIds: string[];
  permissionCount: number;
  allMembersHavePermission: boolean;
  permissions: unknown[];
};

type ShareCreatedPayload = {
  runId: string;
  marker: string;
  resource: SharedResource;
  share: ShareResult;
};

const SHARED_DOC_TITLE_SUFFIX = "owner 分享验收文档";
const SHARED_DOC_BODY =
  "这是一份由 文件共享Owner 分享给成员A、成员B、成员C的 Electron E2E 测试资源。";

function buildSharedDocTitle(prepared: Pick<FileSharedVisibleToMemberPreparation, "marker">): string {
  return `${prepared.marker} ${SHARED_DOC_TITLE_SUFFIX}`;
}

function requirePreparation(context: RunContext): FileSharedVisibleToMemberPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof data.organizationId !== "string" ||
    typeof (data as { targetSpace?: { id?: unknown } }).targetSpace?.id !== "string" ||
    typeof (data as { ownerSpace?: { id?: unknown } }).ownerSpace?.id !== "string" ||
    typeof (data as { viewerMember?: { userId?: unknown } }).viewerMember?.userId !== "string" ||
    typeof (data as { owner?: { userId?: unknown; displayName?: unknown } }).owner?.userId !== "string" ||
    typeof (data as { owner?: { userId?: unknown; displayName?: unknown } }).owner?.displayName !== "string" ||
    !Array.isArray((data as { members?: unknown }).members) ||
    !Array.isArray((data as { memberUserIds?: unknown }).memberUserIds)
  ) {
    throw new Error("file.shared-visible-to-member requires prepared organization, owner Space, target Space and members.");
  }
  return data as unknown as FileSharedVisibleToMemberPreparation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactForProgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(redactForProgress);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/body|content|markdown|text|token|input|value/i.test(key)) {
      output[key] = "<redacted>";
    } else {
      output[key] = redactForProgress(item);
    }
  }
  return output;
}

function summarizeForProgress(value: unknown): string {
  const text = JSON.stringify(redactForProgress(value));
  if (!text) return "no observation yet";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function redactAuthOutput(stdout: string): string {
  return stdout
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"<redacted>"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"<redacted>"');
}

function evalRendererJson<T>(
  context: RunContext,
  expression: string,
  options: { timeoutMs?: number } = {},
): T {
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 70000,
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

function cdpTargetExpression(
  target:
    | "desktop"
    | "dismiss-overlay"
    | "cloud-drive"
    | "new-resource"
    | "create-document"
    | "doc-title-input"
    | "doc-body-editor"
    | "shared-with-me"
    | "shared-resource",
  prepared: Partial<PreparedWithResource> = {},
): string {
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
  const center = (el) => {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      label: textOf(el).slice(0, 160),
      tag: el.tagName,
      role: el.getAttribute?.('role') || '',
      ariaLabel: el.getAttribute?.('aria-label') || '',
    };
  };
  const all = (selector) => Array.from(document.querySelectorAll(selector)).filter(isVisible);
  if (target === 'dismiss-overlay') {
    const el = all('button,[role="button"]').find((item) => /知道了|Got it|OK/i.test(textOf(item)));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'desktop') {
    const el = all('button,[role="button"],a').find((item) => /桌面|Desktop/i.test(textOf(item)));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'cloud-drive') {
    const candidates = all('button,[role="button"],a').filter((item) => {
      const text = textOf(item);
      return /云盘|Cloud Drive/i.test(text) && !/取消置顶|置顶|Unpin|Pin/i.test(text);
    });
    const bodyText = document.body.innerText || '';
    const mainAreaCandidate = candidates.find((item) => item.getBoundingClientRect().left > 300);
    const el = bodyText.includes('桌面是公共工作台') && mainAreaCandidate ? mainAreaCandidate : candidates[0];
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'new-resource') {
    const el = all('button,[role="button"]').find((item) => /新建资源|New Resource|New resource/i.test(textOf(item)));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'create-document') {
    const menuButtons = all('[data-radix-popper-content-wrapper] button,[role="dialog"] button,[role="menu"] button,[cmdk-item]');
    const el = menuButtons.find((item) => /文档|Document|Docs?/i.test(textOf(item)))
      || all('button,[role="button"],[cmdk-item]').reverse().find((item) => /文档|Document|Docs?/i.test(textOf(item)));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'doc-title-input') {
    const el = all('input').find((item) => {
      const placeholder = item.getAttribute('placeholder') || '';
      return /标题|title/i.test(placeholder);
    });
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'doc-body-editor') {
    const editor = all('.ProseMirror,[contenteditable="true"]').find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 200 && rect.height > 40;
    });
    if (editor) {
      const rect = editor.getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(rect.left + Math.min(80, Math.max(20, rect.width / 4))),
        y: Math.round(rect.top + Math.min(40, Math.max(20, rect.height / 4))),
        label: textOf(editor).slice(0, 160),
        tag: editor.tagName,
        role: editor.getAttribute?.('role') || '',
        ariaLabel: editor.getAttribute?.('aria-label') || '',
      });
    }
  }
  if (target === 'shared-with-me') {
    const el = all('button,[role="button"]').find((item) => /分享给我|Shared with me/i.test(textOf(item)));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'shared-resource') {
    const title = prepared.resource?.title || '';
    const sharedBy = prepared.owner?.displayName ? ('由 ' + prepared.owner.displayName + ' 分享') : '';
    const row = all('[role="button"],button,a').find((item) => {
      const text = textOf(item);
      return title && text.includes(title) && (!sharedBy || text.includes(sharedBy));
    });
    if (row) return JSON.stringify(center(row));
  }
  return JSON.stringify({
    error: 'target not found',
    target,
    bodyText: (document.body.innerText || '').slice(0, 6000),
    visible: all('button,[role="button"],a').slice(0, 80).map((item) => textOf(item).slice(0, 120)),
  });
})()
`;
}

function cloudDriveEvidenceExpression(prepared: PreparedWithResource): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const expectedBody = ${JSON.stringify(SHARED_DOC_BODY)};
  const bodyText = document.body.innerText || '';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editorText = Array.from(document.querySelectorAll('.ProseMirror,[contenteditable="true"]'))
    .filter(isVisible)
    .map((item) => item.innerText || item.textContent || '')
    .join('\\n');
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
  const visibleButtons = buttons
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((button) => ({
      text: (button.innerText || button.textContent || '').trim(),
      ariaLabel: button.getAttribute('aria-label') || '',
      ariaPressed: button.getAttribute('aria-pressed') || '',
    }));
  const sharedButton = visibleButtons.find((button) => /分享给我|Shared with me/i.test(button.ariaLabel || button.text));
  const sharedByText = '由 ' + prepared.owner.displayName + ' 分享';
  const expectedTabKey = 'tabdoc:' + prepared.resource.documentId;
  const activeTabText = Array.from(document.querySelectorAll('[aria-current="page"],[data-state="active"],button,[role="tab"]'))
    .map((item) => (item.innerText || item.textContent || '').trim())
    .join('\\n');
  let activeDocumentIdMatched = false;
  try {
    const raw = localStorage.getItem('tabtin-prefs-context-tabs');
    const tabState = raw ? JSON.parse(raw)?.state : null;
    const activeValues = Object.values(tabState?.activeKeyBySpace || {});
    activeDocumentIdMatched = activeValues.includes(expectedTabKey);
  } catch {}
  return JSON.stringify({
    ready: Boolean(sharedButton) && (
      bodyText.includes('云盘') ||
      bodyText.includes('Cloud Drive') ||
      bodyText.includes('标题') ||
      bodyText.includes(prepared.resource.title)
    ),
    sharedButtonFound: Boolean(sharedButton),
    sharedButtonPressed: sharedButton?.ariaPressed === 'true' || /分享给我|Shared with me/i.test(activeTabText),
    foundTitle: bodyText.includes(prepared.resource.title),
    foundBody: editorText.includes(expectedBody),
    foundSharedBy: bodyText.includes(sharedByText),
    activeTabLooksOpened: activeTabText.includes(prepared.resource.title),
    activeDocumentIdMatched,
    editorLoaded: bodyText.includes(prepared.resource.title) && (
      bodyText.includes('已同步') ||
      bodyText.includes('全文评论') ||
      bodyText.includes('Find') ||
      bodyText.includes('查找') ||
      bodyText.includes('请输入标题')
    ),
    bodyText: bodyText.slice(0, 9000),
    editorText: editorText.slice(0, 3000),
    visibleButtons,
  });
})()
`;
}

function createdDocumentEditorEvidenceExpression(): string {
  return `
(() => {
  const bodyText = document.body.innerText || '';
  const titleInput = Array.from(document.querySelectorAll('input')).find((input) => {
    const placeholder = input.getAttribute('placeholder') || '';
    return /标题|title/i.test(placeholder);
  });
  return JSON.stringify({
    editorLoaded: Boolean(titleInput) || bodyText.includes('分享') || bodyText.includes('全文评论'),
    hasTitleInput: Boolean(titleInput),
    bodyText: bodyText.slice(0, 6000),
  });
})()
`;
}

function ownerEditedDocumentEvidenceExpression(expectedTitle: string, expectedBody: string): string {
  return `
(() => {
  const expectedTitle = ${JSON.stringify(expectedTitle)};
  const expectedBody = ${JSON.stringify(expectedBody)};
  const bodyText = document.body.innerText || '';
  const titleInput = Array.from(document.querySelectorAll('input')).find((input) => {
    const placeholder = input.getAttribute('placeholder') || '';
    return /标题|title/i.test(placeholder);
  });
  const titleValue = titleInput?.value || '';
  return JSON.stringify({
    titleVisible: bodyText.includes(expectedTitle) || titleValue === expectedTitle,
    bodyVisible: bodyText.includes(expectedBody),
    synced: bodyText.includes('已同步') || bodyText.includes('Saved') || bodyText.includes('Synced'),
    titleValue,
    bodyText: bodyText.slice(0, 9000),
  });
})()
`;
}

function cloudDrivePageReadyExpression(): string {
  return `
(() => {
  const bodyText = document.body.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
    .map((item) => [
      item.getAttribute?.('aria-label') || '',
      item.getAttribute?.('title') || '',
      item.innerText || '',
      item.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim());
  return JSON.stringify({
    ready: (
      (bodyText.includes('集中管理团队内的文档') || bodyText.includes('Cloud Drive')) &&
      buttons.some((text) => /分享给我|Shared with me/i.test(text))
    ),
    hasNewResourceButton: buttons.some((text) => /新建资源|New Resource|New resource/i.test(text)),
    bodyText: bodyText.slice(0, 4000),
    visibleButtons: buttons.slice(0, 80),
  });
})()
`;
}

async function cdpClick(
  context: RunContext,
  artifactName: string,
  target:
    | "desktop"
    | "dismiss-overlay"
    | "cloud-drive"
    | "new-resource"
    | "create-document"
    | "doc-title-input"
    | "doc-body-editor"
    | "shared-with-me"
    | "shared-resource",
  prepared: Partial<PreparedWithResource> = {},
): Promise<void> {
  await cdpClickByExpression(context, artifactName, cdpTargetExpression(target, prepared), {
    targetLabel: target,
  });
}

async function dismissKnownOverlayIfPresent(context: RunContext, logPrefix: string): Promise<void> {
  try {
    await cdpClick(context, `${logPrefix}-dismiss-overlay-cdp`, "dismiss-overlay");
    await sleep(300);
  } catch {
    // No onboarding/help overlay is present. Continue with the visible user path.
  }
}

async function waitForCloudDrivePage(
  context: RunContext,
  label: string,
  timeoutMs: number,
): Promise<{ ready: boolean; hasNewResourceButton: boolean; bodyText: string; visibleButtons: string[] }> {
  return pollRenderer<{ ready: boolean; hasNewResourceButton: boolean; bodyText: string; visibleButtons: string[] }>(
    context,
    cloudDrivePageReadyExpression,
    (value) => value.ready,
    { timeoutMs, intervalMs: 1500, label },
  );
}

async function openCloudDriveByClicks(
  context: RunContext,
  logPrefix: string,
  prepared: Partial<PreparedWithResource>,
): Promise<void> {
  try {
    await waitForCloudDrivePage(context, `${logPrefix} Cloud Drive already open`, 2000);
    return;
  } catch {
    // Continue with user-visible navigation below.
  }

  await dismissKnownOverlayIfPresent(context, logPrefix);
  await cdpClick(context, `${logPrefix}-click-cloud-drive-cdp`, "cloud-drive", prepared);
  try {
    await waitForCloudDrivePage(context, `${logPrefix} Cloud Drive page`, 12000);
    return;
  } catch {
    await cdpClick(context, `${logPrefix}-click-desktop-cdp`, "desktop", prepared);
    await sleep(1000);
    await dismissKnownOverlayIfPresent(context, logPrefix);
    await cdpClick(context, `${logPrefix}-click-cloud-drive-after-desktop-cdp`, "cloud-drive", prepared);
    await waitForCloudDrivePage(context, `${logPrefix} Cloud Drive page after desktop`, 30000);
  }
}

async function runAuthDjango(
  context: RunContext,
  prepared: FileSharedVisibleToMemberPreparation,
  input: { userId: string; spaceId: string; role: string; logName: string },
): Promise<E2eAuthPayload> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/file_shared_visible_to_member_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "auth",
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_AUTH_USER_ID: input.userId,
        TABTIN_E2E_ORGANIZATION_ID: prepared.organizationId,
        TABTIN_E2E_SPACE_ID: input.spaceId,
        TABTIN_E2E_ROLE: input.role,
      },
    },
  );
  await context.writeText(`logs/${input.logName}.log`, redactAuthOutput(result.stdout));
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, "@@E2E@@");
}

async function shareUiCreatedDocument(
  context: RunContext,
  prepared: FileSharedVisibleToMemberPreparation,
  expected: { title: string },
): Promise<ShareCreatedPayload> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/file_shared_visible_to_member_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "share_created",
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_OWNER_ID: prepared.owner.userId,
        TABTIN_E2E_OWNER_SPACE_ID: prepared.ownerSpace.id,
        TABTIN_E2E_MEMBER_USER_IDS: JSON.stringify(prepared.memberUserIds),
        TABTIN_E2E_EXPECTED_TITLE: expected.title,
      },
    },
  );
  await context.writeText("logs/file-shared-visible-to-member-share-created-django.log", result.stdout);
  return parseJsonSentinel<ShareCreatedPayload>(result.stdout, "@@E2E@@");
}

async function runVerifyDjango(
  context: RunContext,
  prepared: PreparedWithResource,
): Promise<{ payload: SharedFileBackendVerification; artifacts: string[] }> {
  const memberIds = prepared.members.map((member) => member.userId);
  try {
    const result = runCommand(
      resolvePythonCommand(context.repoRoot),
      [
        "apps/tabtin_django/manage.py",
        "shell",
        "-c",
        "exec(open('tests/electron/fixtures/file_shared_visible_to_member_case.py', encoding='utf-8').read())",
      ],
      {
        cwd: context.repoRoot,
        timeoutMs: 60000,
        env: {
          ...process.env,
          TABTIN_E2E_MODE: "verify",
          TABTIN_E2E_RUN_ID: prepared.runId,
          TABTIN_E2E_DOCUMENT_ID: prepared.resource.documentId,
          TABTIN_E2E_ORGANIZATION_ID: prepared.organizationId,
          TABTIN_E2E_VIEWER_MEMBER_ID: prepared.viewerMember.userId,
          TABTIN_E2E_EXPECTED_MEMBER_IDS: JSON.stringify(memberIds),
        },
      },
    );
    const logPath = await context.writeText("logs/file-shared-visible-to-member-verify-django.log", result.stdout);
    return {
      payload: parseJsonSentinel<SharedFileBackendVerification>(result.stdout, "@@E2E@@"),
      artifacts: [logPath],
    };
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      const stdoutPath = await context.writeText("logs/file-shared-visible-to-member-verify-django.log", error.stdout);
      const stderrPath = await context.writeText("logs/file-shared-visible-to-member-verify-django.stderr.log", error.stderr);
      error.message = `${error.message}\nArtifacts: ${stdoutPath}, ${stderrPath}`;
    }
    throw error;
  }
}

export async function runFileSharedVisibleToMemberCase(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-action-input.json", {
    runId: context.runId,
    scenarioId: context.scenarioId,
    prepared,
  }));

  await context.reportProgress("FILE", "switch to owner and open Cloud Drive by real click");
  const ownerAuth = await runAuthDjango(context, prepared, {
    userId: prepared.owner.userId,
    spaceId: prepared.ownerSpace.id,
    role: "owner",
    logName: "file-shared-visible-to-member-owner-auth-django",
  });
  await saveElectronAuthPayload(context, ownerAuth, "file-shared-visible-to-member-owner");
  artifacts.push(await context.writeJson(
    "snapshots/file-shared-visible-to-member-owner-selection.json",
    await readElectronSelectionAfterAuthBootstrap(context, ownerAuth),
  ));
  await openCloudDriveByClicks(context, "file-shared-visible-to-member-owner", prepared);
  await sleep(2000);

  await context.reportProgress("FILE", "owner creates TabDoc from Cloud Drive with real clicks");
  await cdpClick(context, "file-shared-visible-to-member-owner-click-new-resource-cdp", "new-resource", prepared);
  await sleep(700);
  await cdpClick(context, "file-shared-visible-to-member-owner-click-create-document-cdp", "create-document", prepared);
  const createdEditor = await pollRenderer<{ editorLoaded: boolean; hasTitleInput: boolean; bodyText: string }>(
    context,
    createdDocumentEditorEvidenceExpression,
    (value) => value.editorLoaded,
    { timeoutMs: 60000, intervalMs: 3000, label: "UI-created TabDoc editor" },
  );
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-created-editor.json", createdEditor));

  const ownerTitle = buildSharedDocTitle(prepared);
  await context.reportProgress("FILE", "owner types title and body in TabDoc with CDP input");
  await cdpClick(context, "file-shared-visible-to-member-owner-click-title-input-cdp", "doc-title-input", prepared);
  await cdpInsertText(context, "file-shared-visible-to-member-owner-insert-title-cdp", ownerTitle);
  await cdpClick(context, "file-shared-visible-to-member-owner-click-body-editor-cdp", "doc-body-editor", prepared);
  await cdpInsertText(context, "file-shared-visible-to-member-owner-insert-body-cdp", SHARED_DOC_BODY);
  const ownerEdited = await pollRenderer<{
    titleVisible: boolean;
    bodyVisible: boolean;
    synced: boolean;
    titleValue: string;
    bodyText: string;
  }>(
    context,
    () => ownerEditedDocumentEvidenceExpression(ownerTitle, SHARED_DOC_BODY),
    (value) => value.titleVisible && value.bodyVisible && value.synced,
    { timeoutMs: 60_000, intervalMs: 3_000, label: "owner typed TabDoc title/body synced" },
  );
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-owner-edited-doc.json", ownerEdited));

  await context.reportProgress("FILE", "share the UI-created and UI-edited document to members A/B/C");
  const sharedPayload = await shareUiCreatedDocument(context, prepared, {
    title: ownerTitle,
  });
  const preparedWithResource: PreparedWithResource = {
    ...prepared,
    resource: sharedPayload.resource,
    share: sharedPayload.share,
  };
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-shared-resource.json", sharedPayload));

  await context.reportProgress("FILE", "switch to member B and open Cloud Drive by real click");
  const memberAuth = await runAuthDjango(context, prepared, {
    userId: prepared.viewerMember.userId,
    spaceId: prepared.targetSpace.id,
    role: prepared.viewerMember.role,
    logName: "file-shared-visible-to-member-viewer-auth-django",
  });
  await saveElectronAuthPayload(context, memberAuth, "file-shared-visible-to-member-viewer");
  artifacts.push(await context.writeJson(
    "snapshots/file-shared-visible-to-member-viewer-selection.json",
    await readElectronSelectionAfterAuthBootstrap(context, memberAuth),
  ));
  await openCloudDriveByClicks(context, "file-shared-visible-to-member-viewer", preparedWithResource);
  await sleep(3000);

  const cloudReady = await pollRenderer<CloudDriveEvidence>(
    context,
    () => cloudDriveEvidenceExpression(preparedWithResource),
    (value) => value.ready && value.sharedButtonFound,
    { timeoutMs: 45000, intervalMs: 3000, label: "Cloud Drive ready" },
  );
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-cloud-ready.json", cloudReady));

  await context.reportProgress("FILE", "member B clicks shared-with-me filter by CDP mouse");
  await cdpClick(context, "file-shared-visible-to-member-click-shared-cdp", "shared-with-me", preparedWithResource);

  await context.reportProgress("FILE", `wait for shared resource ${preparedWithResource.resource.title}`);
  const sharedVisible = await pollRenderer<CloudDriveEvidence>(
    context,
    () => cloudDriveEvidenceExpression(preparedWithResource),
    (value) => value.sharedButtonPressed && value.foundTitle && value.foundSharedBy,
    { timeoutMs: 60000, intervalMs: 3000, label: "shared resource visible in Cloud Drive" },
  );
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-ui-visible.json", sharedVisible));
  if (!sharedVisible.foundTitle || !sharedVisible.foundSharedBy) {
    return {
      id: "file.shared-visible-to-member.verify-shared-file-list",
      title: "通过 Electron UI 验证成员能看到 owner 分享的文件并打开",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message: `file.shared-visible-to-member failed: shared file title or owner marker not visible for ${prepared.viewerMember.displayName}.`,
      artifacts,
    };
  }

  await context.reportProgress("FILE", "member B clicks and opens the shared document by CDP mouse");
  await cdpClick(context, "file-shared-visible-to-member-click-shared-resource-cdp", "shared-resource", preparedWithResource);
  const opened = await pollRenderer<CloudDriveEvidence>(
    context,
    () => cloudDriveEvidenceExpression(preparedWithResource),
    (value) => value.activeDocumentIdMatched && value.editorLoaded && value.foundTitle && value.foundBody,
    { timeoutMs: 60000, intervalMs: 3000, label: "shared TabDoc opened" },
  );
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-opened-tabdoc.json", opened));
  if (!opened.activeDocumentIdMatched || !opened.editorLoaded || !opened.foundTitle || !opened.foundBody) {
    return {
      id: "file.shared-visible-to-member.verify-shared-file-list",
      title: "通过 Electron UI 验证成员能看到 owner 分享的文件并打开",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        "file.shared-visible-to-member failed: clicked shared resource but the opened TabDoc did not show the UI-typed title/body.",
      artifacts,
    };
  }

  await context.reportProgress("FILE", "verify shared-with-me backend contract");
  const verify = await runVerifyDjango(context, preparedWithResource);
  artifacts.push(await context.writeJson("snapshots/file-shared-visible-to-member-backend-verify.json", verify.payload));
  artifacts.push(...verify.artifacts);
  if (!verify.payload.sharedWithMeMatched || !verify.payload.allMembersHavePermission) {
    return {
      id: "file.shared-visible-to-member.verify-shared-file-list",
      title: "通过 Electron UI 验证成员能看到 owner 分享的文件并打开",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        "file.shared-visible-to-member failed: backend shared-with-me or DocumentPermission verification did not match prepared data.",
      artifacts,
    };
  }

  return {
    id: "file.shared-visible-to-member.verify-shared-file-list",
    title: "通过 Electron UI 验证成员能看到 owner 分享的文件并打开",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message:
      "file.shared-visible-to-member passed: owner created a TabDoc through Electron clicks; member B clicked shared-with-me, opened the owner-shared file, and remained on the opened TabDoc.",
    artifacts,
  };
}
