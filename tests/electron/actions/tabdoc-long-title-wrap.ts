import type { RunContext, StepResult } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "../fixtures/electron-local-auth";
import type { TabdocLongTitleWrapPreparation } from "../fixtures/prepare-tabdoc-long-title-wrap";
import { cdpClickByExpression } from "./real-user-input";

type RendererEvidence = {
  ready?: boolean;
  foundTitleTextarea?: boolean;
  titleValueMatches?: boolean;
  editorLoaded?: boolean;
  bodyText: string;
  visibleTargets?: string[];
};

type TitleLayoutEvidence = {
  ready: boolean;
  valueMatches: boolean;
  softWrapped: boolean;
  noHorizontalOverflow: boolean;
  withinPageContainer: boolean;
  approxLineCount: number;
  expectedMinLines: number;
  titleValueLength: number;
  wrapAttr: string | null;
  className: string;
  style: {
    whiteSpace: string;
    overflowWrap: string;
    wordBreak: string;
    overflowX: string;
    overflowY: string;
    lineHeight: string;
    fontSize: string;
  };
  metrics: {
    rectWidth: number;
    rectHeight: number;
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
    lineHeightPx: number;
    pageRectWidth: number | null;
    rectLeft: number;
    rectRight: number;
    pageLeft: number | null;
    pageRight: number | null;
  };
  bodyText: string;
  error?: string;
};

type BackendVerification = {
  runId: string;
  documentId: string;
  title: string;
  titleMatches: boolean;
  spaceId: string;
  spaceMatches: boolean;
  organizationId: string;
  organizationMatches: boolean;
  status: string;
  contextItem: null | {
    id: string;
    title: string;
    resourceId: string;
    titleMatches: boolean;
    resourceMatches: boolean;
  };
};

type CdpTarget = "desktop" | "dismiss-overlay" | "cloud-drive" | "document-resource";

function requirePreparation(context: RunContext): TabdocLongTitleWrapPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof (data as { authUser?: { userId?: unknown } }).authUser?.userId !== "string" ||
    typeof (data as { organization?: { id?: unknown } }).organization?.id !== "string" ||
    typeof (data as { space?: { id?: unknown } }).space?.id !== "string" ||
    typeof (data as { document?: { id?: unknown; title?: unknown; expectedMinLines?: unknown } }).document?.id !== "string" ||
    typeof (data as { document?: { id?: unknown; title?: unknown; expectedMinLines?: unknown } }).document?.title !== "string" ||
    typeof (data as { document?: { id?: unknown; title?: unknown; expectedMinLines?: unknown } }).document?.expectedMinLines !== "number" ||
    typeof (data as { contextItem?: { id?: unknown; resourceId?: unknown } }).contextItem?.id !== "string" ||
    typeof (data as { contextItem?: { id?: unknown; resourceId?: unknown } }).contextItem?.resourceId !== "string"
  ) {
    throw new Error("tabdoc.long-title-wrap requires prepared auth, Space, Document and ContextItem data.");
  }
  return data as unknown as TabdocLongTitleWrapPreparation;
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

function cdpTargetExpression(target: CdpTarget, prepared: TabdocLongTitleWrapPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const target = ${JSON.stringify(target)};
  const textOf = (el) => [
    el.getAttribute?.('aria-label') || '',
    el.getAttribute?.('title') || '',
    el.getAttribute?.('placeholder') || '',
    el.innerText || '',
    el.textContent || '',
    el.value || '',
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
      ariaLabel: el.getAttribute?.('aria-label') || '',
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
  if (target === 'document-resource') {
    const title = prepared.document.title;
    const rows = all('[role="button"],button,a,[draggable="true"]').filter((item) => {
      const text = textOf(item);
      return text.includes(title) || (text.includes(prepared.marker) && text.includes('TabDocLongTitleWrap'));
    });
    const el = rows.find((item) => item.getAttribute?.('draggable') === 'true') || rows[0];
    if (el) return JSON.stringify(center(el, { preferTitleCell: true }));
  }
  return JSON.stringify({
    error: 'target not found',
    target,
    bodyText: (document.body.innerText || '').slice(0, 6000),
    visible: all('input,textarea,[contenteditable="true"],button,[role="button"],a,[draggable="true"]')
      .slice(0, 120)
      .map((item) => textOf(item).slice(0, 180)),
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
  prepared: TabdocLongTitleWrapPreparation,
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

function documentOpenedExpression(prepared: TabdocLongTitleWrapPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const title = prepared.document.title;
  const bodyText = document.body.innerText || '';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const titleTextareas = Array.from(document.querySelectorAll('textarea')).filter(isVisible);
  const matchingTitle = titleTextareas.find((item) => item.value === title);
  const titleCandidate = matchingTitle || titleTextareas.find((item) => /标题|title/i.test([
    item.getAttribute('aria-label') || '',
    item.getAttribute('placeholder') || '',
  ].join(' ')));
  const editorLoaded = Boolean(titleCandidate) && (
    bodyText.includes('已同步') ||
    bodyText.includes('Saved') ||
    bodyText.includes('Synced') ||
    bodyText.includes('全文评论') ||
    bodyText.includes('Find') ||
    bodyText.includes('查找')
  );
  return JSON.stringify({
    ready: Boolean(matchingTitle) && editorLoaded,
    foundTitleTextarea: Boolean(titleCandidate),
    titleValueMatches: Boolean(matchingTitle),
    editorLoaded,
    bodyText: bodyText.slice(0, 8000),
    visibleTargets: titleTextareas.map((item) => ({
      value: item.value.slice(0, 160),
      placeholder: item.getAttribute('placeholder') || '',
      ariaLabel: item.getAttribute('aria-label') || '',
    })).slice(0, 20),
  });
})()
`;
}

function titleLayoutEvidenceExpression(prepared: TabdocLongTitleWrapPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const expectedTitle = prepared.document.title;
  const expectedMinLines = prepared.document.expectedMinLines;
  const bodyText = document.body.innerText || '';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const title = Array.from(document.querySelectorAll('textarea'))
    .filter(isVisible)
    .find((item) => item.value === expectedTitle);
  if (!title) {
    return JSON.stringify({
      ready: false,
      valueMatches: false,
      softWrapped: false,
      noHorizontalOverflow: false,
      withinPageContainer: false,
      approxLineCount: 0,
      expectedMinLines,
      titleValueLength: 0,
      wrapAttr: null,
      className: '',
      style: {
        whiteSpace: '',
        overflowWrap: '',
        wordBreak: '',
        overflowX: '',
        overflowY: '',
        lineHeight: '',
        fontSize: '',
      },
      metrics: {
        rectWidth: 0,
        rectHeight: 0,
        clientWidth: 0,
        scrollWidth: 0,
        clientHeight: 0,
        scrollHeight: 0,
        lineHeightPx: 0,
        pageRectWidth: null,
        rectLeft: 0,
        rectRight: 0,
        pageLeft: null,
        pageRight: null,
      },
      bodyText: bodyText.slice(0, 4000),
      error: 'title textarea not found',
    });
  }
  title.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  const rect = title.getBoundingClientRect();
  const page = title.closest('.tabdoc-page');
  const pageRect = page ? page.getBoundingClientRect() : null;
  const computed = window.getComputedStyle(title);
  const fontSize = Number.parseFloat(computed.fontSize) || 16;
  const parsedLineHeight = Number.parseFloat(computed.lineHeight);
  const lineHeightPx = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.2;
  const measuredHeight = Math.max(title.scrollHeight, title.clientHeight, rect.height);
  const approxLineCount = Math.max(1, Math.round(measuredHeight / lineHeightPx));
  const noHorizontalOverflow = title.scrollWidth <= title.clientWidth + 2;
  const withinPageContainer = pageRect
    ? rect.left >= pageRect.left - 2 && rect.right <= pageRect.right + 2
    : true;
  const softWrapped = approxLineCount >= expectedMinLines && rect.height > lineHeightPx * 1.5;
  return JSON.stringify({
    ready: title.value === expectedTitle && softWrapped && noHorizontalOverflow && withinPageContainer,
    valueMatches: title.value === expectedTitle,
    softWrapped,
    noHorizontalOverflow,
    withinPageContainer,
    approxLineCount,
    expectedMinLines,
    titleValueLength: title.value.length,
    wrapAttr: title.getAttribute('wrap'),
    className: title.className || '',
    style: {
      whiteSpace: computed.whiteSpace,
      overflowWrap: computed.overflowWrap,
      wordBreak: computed.wordBreak,
      overflowX: computed.overflowX,
      overflowY: computed.overflowY,
      lineHeight: computed.lineHeight,
      fontSize: computed.fontSize,
    },
    metrics: {
      rectWidth: rect.width,
      rectHeight: rect.height,
      clientWidth: title.clientWidth,
      scrollWidth: title.scrollWidth,
      clientHeight: title.clientHeight,
      scrollHeight: title.scrollHeight,
      lineHeightPx,
      pageRectWidth: pageRect ? pageRect.width : null,
      rectLeft: rect.left,
      rectRight: rect.right,
      pageLeft: pageRect ? pageRect.left : null,
      pageRight: pageRect ? pageRect.right : null,
    },
    bodyText: bodyText.slice(0, 4000),
  });
})()
`;
}

async function cdpClick(
  context: RunContext,
  artifactName: string,
  target: CdpTarget,
  prepared: TabdocLongTitleWrapPreparation,
): Promise<void> {
  await cdpClickByExpression(context, artifactName, cdpTargetExpression(target, prepared), {
    targetLabel: target,
  });
}

async function dismissKnownOverlayIfPresent(
  context: RunContext,
  prepared: TabdocLongTitleWrapPreparation,
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
  prepared: TabdocLongTitleWrapPreparation,
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

  await dismissKnownOverlayIfPresent(context, prepared, "tabdoc-long-title-wrap");
  await cdpClick(context, "tabdoc-long-title-wrap-click-cloud-drive-cdp", "cloud-drive", prepared);
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
      await cdpClick(context, "tabdoc-long-title-wrap-click-desktop-cdp", "desktop", prepared);
      await sleep(1000);
      await dismissKnownOverlayIfPresent(context, prepared, "tabdoc-long-title-wrap-after-desktop");
      await cdpClick(context, "tabdoc-long-title-wrap-click-cloud-drive-after-desktop-cdp", "cloud-drive", prepared);
      await pollRenderer<RendererEvidence>(
        context,
        cloudDrivePageReadyExpression,
        (value) => Boolean(value.ready),
        { timeoutMs: 30_000, intervalMs: 1500, label: "Cloud Drive page after desktop" },
      );
    } catch {
      await context.reportProgress("TABDOC", "Cloud Drive click path did not switch page; bootstrap apphome tab for navigation only");
      const bootstrap = evalRendererJson<{ ok: boolean; scopeKey: string; tabKey: string }>(
        context,
        cloudDriveBootstrapExpression(prepared, authPayload),
        { timeoutMs: 30_000 },
      );
      await context.writeJson("snapshots/tabdoc-long-title-wrap-cloud-bootstrap.json", bootstrap);
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

async function runAuthDjango(
  context: RunContext,
  prepared: TabdocLongTitleWrapPreparation,
): Promise<E2eAuthPayload> {
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
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "auth",
        TABTIN_E2E_RUN_ID: prepared.runId,
      },
    },
  );
  await context.writeText(
    "logs/tabdoc-long-title-wrap-auth-django.log",
    result.stdout
      .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
      .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"'),
  );
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, "@@E2E@@");
}

async function runVerifyDjango(
  context: RunContext,
  prepared: TabdocLongTitleWrapPreparation,
): Promise<BackendVerification> {
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
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "verify",
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_DOCUMENT_ID: prepared.document.id,
        TABTIN_E2E_EXPECTED_TITLE: prepared.document.title,
        TABTIN_E2E_SPACE_ID: prepared.space.id,
        TABTIN_E2E_ORGANIZATION_ID: prepared.organization.id,
      },
    },
  );
  await context.writeText("logs/tabdoc-long-title-wrap-verify-django.log", result.stdout);
  return parseJsonSentinel<BackendVerification>(result.stdout, "@@E2E@@");
}

export async function runTabdocLongTitleWrapCase(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);
  artifacts.push(await context.writeJson("snapshots/tabdoc-long-title-wrap-action-input.json", {
    runId: context.runId,
    scenarioId: context.scenarioId,
    prepared,
    requiredUiAction: "real mouse click from Cloud Drive resource row/card to open the prepared TabDoc",
    expectedUiEvidence: {
      titleValue: prepared.document.title,
      minWrappedLines: prepared.document.expectedMinLines,
      noHorizontalOverflow: true,
    },
    expectedPersistenceEvidence: {
      documentId: prepared.document.id,
      title: prepared.document.title,
    },
  }));

  await context.reportProgress("TABDOC", "bootstrap local auth and open Cloud Drive");
  const authPayload = await runAuthDjango(context, prepared);
  await saveElectronAuthPayload(context, authPayload, "tabdoc-long-title-wrap");
  await openCloudDriveByClicks(context, prepared, authPayload);

  await context.reportProgress("TABDOC", "open prepared long-title TabDoc by real click");
  await cdpClick(context, "tabdoc-long-title-wrap-click-document-cdp", "document-resource", prepared);
  const opened = await pollRenderer<RendererEvidence>(
    context,
    () => documentOpenedExpression(prepared),
    (value) => Boolean(value.ready && value.titleValueMatches && value.editorLoaded),
    { timeoutMs: 60_000, intervalMs: 3000, label: "long-title TabDoc opened" },
  );
  artifacts.push(await context.writeJson("snapshots/tabdoc-long-title-wrap-opened-doc.json", opened));

  await context.reportProgress("TABDOC", "measure title textarea wrapping and horizontal overflow");
  const layout = await pollRenderer<TitleLayoutEvidence>(
    context,
    () => titleLayoutEvidenceExpression(prepared),
    (value) => Boolean(value.ready),
    { timeoutMs: 45_000, intervalMs: 1500, label: "long title wrapped inside page container" },
  );
  artifacts.push(await context.writeJson("snapshots/tabdoc-long-title-wrap-layout.json", layout));

  await context.reportProgress("TABDOC", "verify backend document and ContextItem title still match");
  const verify = await runVerifyDjango(context, prepared);
  artifacts.push(await context.writeJson("snapshots/tabdoc-long-title-wrap-backend-verify.json", verify));
  const backendPassed = (
    verify.titleMatches &&
    verify.spaceMatches &&
    verify.organizationMatches &&
    verify.status === "active" &&
    Boolean(verify.contextItem?.titleMatches) &&
    Boolean(verify.contextItem?.resourceMatches)
  );
  if (!backendPassed) {
    return {
      id: "tabdoc.long-title-wrap.open-and-measure-title",
      title: "通过真实点击打开长标题文档并断言标题软换行",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message: `tabdoc.long-title-wrap failed: backend verification mismatch ${JSON.stringify({
        titleMatches: verify.titleMatches,
        spaceMatches: verify.spaceMatches,
        organizationMatches: verify.organizationMatches,
        status: verify.status,
        contextItem: verify.contextItem,
      })}.`,
      artifacts,
    };
  }

  return {
    id: "tabdoc.long-title-wrap.open-and-measure-title",
    title: "通过真实点击打开长标题文档并断言标题软换行",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message:
      "tabdoc.long-title-wrap passed: the prepared TabDoc opened through real Cloud Drive clicks, title textarea wrapped to multiple lines without horizontal overflow, and backend Document/ContextItem titles matched.",
    artifacts,
  };
}
