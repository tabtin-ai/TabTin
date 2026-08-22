import type { RunContext, StepResult } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import type { TabDocCommentMentionMemberPreparation } from "../fixtures/prepare-tabdoc-comment-mention-member";
import { cdpClickByExpression, cdpInsertText } from "./real-user-input";

type CommentMentionVerification = {
  runId: string;
  documentId: string;
  commentCreated: boolean;
  notificationCreated: boolean;
  comment: unknown;
  notification: unknown;
};

type RendererEvidence = {
  ready?: boolean;
  foundTitle?: boolean;
  foundCommentInput?: boolean;
  candidateFound?: boolean;
  commentVisible?: boolean;
  bodyText: string;
  visibleTargets?: string[];
};

type CdpTarget =
  | "desktop"
  | "dismiss-overlay"
  | "cloud-drive"
  | "document-resource"
  | "comment-input"
  | "mention-candidate"
  | "send-comment";

function requirePreparation(context: RunContext): TabDocCommentMentionMemberPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof (data as { document?: { id?: unknown; title?: unknown } }).document?.id !== "string" ||
    typeof (data as { document?: { id?: unknown; title?: unknown } }).document?.title !== "string" ||
    typeof (data as { mentionedMember?: { userId?: unknown; displayName?: unknown } }).mentionedMember?.userId !== "string" ||
    typeof (data as { mentionedMember?: { userId?: unknown; displayName?: unknown } }).mentionedMember?.displayName !== "string" ||
    typeof (data as { comment?: { text?: unknown } }).comment?.text !== "string"
  ) {
    throw new Error("tabdoc.comment-mention-member requires prepared document, mentioned member and comment text.");
  }
  return data as unknown as TabDocCommentMentionMemberPreparation;
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

function cdpTargetExpression(target: CdpTarget, prepared: TabDocCommentMentionMemberPreparation): string {
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
  const center = (el, offset = {}) => {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + (offset.x ?? rect.width / 2)),
      y: Math.round(rect.top + (offset.y ?? rect.height / 2)),
      label: textOf(el).slice(0, 180),
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
  if (target === 'document-resource') {
    const title = prepared.document.title;
    const el = all('[role="button"],button,a').find((item) => textOf(item).includes(title));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'comment-input') {
    const el = all('input,textarea,[contenteditable="true"]').find((item) => {
      const label = [
        item.getAttribute?.('aria-label') || '',
        item.getAttribute?.('placeholder') || '',
        item.getAttribute?.('title') || '',
      ].join(' ').replace(/\\s+/g, ' ').trim();
      return /输入评论|comment input|comment/i.test(label);
    });
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'mention-candidate') {
    const name = prepared.mentionedMember.displayName;
    const el = all('[role="option"],[cmdk-item],[role="button"],button,li,div').find((item) => textOf(item).includes(name));
    if (el) return JSON.stringify(center(el));
  }
  if (target === 'send-comment') {
    const el = all('button,[role="button"]').find((item) => /发送评论|发送|Send comment|Send/i.test(textOf(item)));
    if (el) return JSON.stringify(center(el));
  }
  return JSON.stringify({
    error: 'target not found',
    target,
    bodyText: (document.body.innerText || '').slice(0, 6000),
    visible: all('input,textarea,[contenteditable="true"],button,[role="button"],a,[role="option"],[cmdk-item]')
      .slice(0, 100)
      .map((item) => textOf(item).slice(0, 140)),
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
      (bodyText.includes('集中管理团队内的文档') || bodyText.includes('Cloud Drive') || bodyText.includes('云盘')) &&
      (buttons.some((text) => /新建资源|New Resource|New resource/i.test(text)) || buttons.some((text) => /分享给我|Shared with me/i.test(text)))
    ),
    bodyText: bodyText.slice(0, 5000),
    visibleTargets: buttons.slice(0, 100),
  });
})()
`;
}

function documentOpenedExpression(prepared: TabDocCommentMentionMemberPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const bodyText = document.body.innerText || '';
  const inputs = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).map((item) => [
    item.getAttribute?.('aria-label') || '',
    item.getAttribute?.('placeholder') || '',
  ].join(' ').replace(/\\s+/g, ' ').trim());
  return JSON.stringify({
    ready: bodyText.includes(prepared.document.title) && inputs.some((text) => /输入评论|评论|comment/i.test(text)),
    foundTitle: bodyText.includes(prepared.document.title),
    foundCommentInput: inputs.some((text) => /输入评论|评论|comment/i.test(text)),
    bodyText: bodyText.slice(0, 8000),
    visibleTargets: inputs.slice(0, 80),
  });
})()
`;
}

function mentionCandidateExpression(prepared: TabDocCommentMentionMemberPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const bodyText = document.body.innerText || '';
  const inputs = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).map((item) => ({
    label: [
      item.getAttribute?.('aria-label') || '',
      item.getAttribute?.('placeholder') || '',
      item.innerText || '',
      item.textContent || '',
      item.value || '',
    ].join(' ').replace(/\\s+/g, ' ').trim(),
  }));
  const candidates = Array.from(document.querySelectorAll('[role="option"],[cmdk-item],[role="listbox"],[role="menu"],[role="dialog"],[role="button"],button,li'))
    .map((item) => (item.innerText || item.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  return JSON.stringify({
    candidateFound: candidates.some((text) => text.includes(prepared.mentionedMember.displayName)),
    bodyText: bodyText.slice(0, 8000),
    visibleTargets: [...inputs.map((item) => item.label), ...candidates].slice(0, 100),
  });
})()
`;
}

function commentVisibleExpression(prepared: TabDocCommentMentionMemberPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    commentVisible: bodyText.includes(prepared.comment.text),
    bodyText: bodyText.slice(0, 8000),
  });
})()
`;
}

async function cdpClick(
  context: RunContext,
  artifactName: string,
  target: CdpTarget,
  prepared: TabDocCommentMentionMemberPreparation,
): Promise<void> {
  await cdpClickByExpression(context, artifactName, cdpTargetExpression(target, prepared), {
    targetLabel: target,
  });
}

async function dismissKnownOverlayIfPresent(
  context: RunContext,
  prepared: TabDocCommentMentionMemberPreparation,
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
  prepared: TabDocCommentMentionMemberPreparation,
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

  await dismissKnownOverlayIfPresent(context, prepared, "tabdoc-comment-mention-member");
  await cdpClick(context, "tabdoc-comment-mention-member-click-cloud-drive-cdp", "cloud-drive", prepared);
  try {
    await pollRenderer<RendererEvidence>(
      context,
      cloudDrivePageReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 12_000, intervalMs: 1500, label: "Cloud Drive page" },
    );
    return;
  } catch {
    await cdpClick(context, "tabdoc-comment-mention-member-click-desktop-cdp", "desktop", prepared);
    await sleep(1000);
    await dismissKnownOverlayIfPresent(context, prepared, "tabdoc-comment-mention-member-after-desktop");
    await cdpClick(context, "tabdoc-comment-mention-member-click-cloud-drive-after-desktop-cdp", "cloud-drive", prepared);
    await pollRenderer<RendererEvidence>(
      context,
      cloudDrivePageReadyExpression,
      (value) => Boolean(value.ready),
      { timeoutMs: 30_000, intervalMs: 1500, label: "Cloud Drive page after desktop" },
    );
  }
}

async function runVerifyDjango(
  context: RunContext,
  prepared: TabDocCommentMentionMemberPreparation,
): Promise<CommentMentionVerification> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/tabdoc_comment_mention_member_case.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "verify",
        TABTIN_E2E_RUN_ID: prepared.runId,
        TABTIN_E2E_DOCUMENT_ID: prepared.document.id,
        TABTIN_E2E_MENTIONED_USER_ID: prepared.mentionedMember.userId,
        TABTIN_E2E_COMMENT_MARKER: prepared.marker,
      },
    },
  );
  await context.writeText("logs/tabdoc-comment-mention-member-verify-django.log", result.stdout);
  return parseJsonSentinel<CommentMentionVerification>(result.stdout, "@@E2E@@");
}

export async function runTabDocCommentMentionMemberCase(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);
  const artifact = await context.writeJson("snapshots/tabdoc-comment-mention-member-action-contract.json", {
    runId: context.runId,
    scenarioId: context.scenarioId,
    prepared,
    requiredRealUserPath: [
      "Click the TabDoc resource from the visible UI.",
      "Click the full-document comments entry or scroll to the comments section.",
      "Click the comment input.",
      "Type @ through CDP/Playwright text input.",
      "Select the mentioned Organization member from the visible candidate list.",
      "Submit the comment through the visible send button or Enter key.",
      "Assert the comment keeps mention semantics and the mentioned member receives a notification.",
    ],
    currentProductGap: [
      "DocumentCommentsSection currently renders a plain Input and has no member mention candidate picker.",
      "The document comment POST body currently only sends body/selected_text/author_name; there is no mentions contract.",
      "DocumentShareService.create_document_comment currently stores only body/author/selected_text and does not create mention notifications.",
    ],
  });
  artifacts.push(artifact);

  await context.reportProgress("TABDOC", "open Cloud Drive through real clicks");
  await openCloudDriveByClicks(context, prepared);

  await context.reportProgress("TABDOC", `open target TabDoc by real click: ${prepared.document.title}`);
  await cdpClick(context, "tabdoc-comment-mention-member-click-document-cdp", "document-resource", prepared);
  const opened = await pollRenderer<RendererEvidence>(
    context,
    () => documentOpenedExpression(prepared),
    (value) => Boolean(value.ready && value.foundTitle && value.foundCommentInput),
    { timeoutMs: 60_000, intervalMs: 3000, label: "TabDoc comments area opened" },
  );
  artifacts.push(await context.writeJson("snapshots/tabdoc-comment-mention-member-opened-doc.json", opened));

  await context.reportProgress("TABDOC", "click comment input and type @ through CDP input");
  await cdpClick(context, "tabdoc-comment-mention-member-click-comment-input-cdp", "comment-input", prepared);
  await cdpInsertText(context, "tabdoc-comment-mention-member-insert-at-cdp", "@");

  let candidate: RendererEvidence;
  try {
    candidate = await pollRenderer<RendererEvidence>(
      context,
      () => mentionCandidateExpression(prepared),
      (value) => Boolean(value.candidateFound),
      { timeoutMs: 12_000, intervalMs: 1500, label: "comment mention member candidate" },
    );
  } catch {
    const evidence = evalRendererJson<RendererEvidence>(context, mentionCandidateExpression(prepared));
    artifacts.push(await context.writeJson("snapshots/tabdoc-comment-mention-member-missing-candidate.json", evidence));
    return {
      id: "tabdoc.comment-mention-member.type-at-select-and-notify",
      title: "通过 Electron UI 在文档评论输入 @ 选择成员并发送提醒",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        "tabdoc.comment-mention-member failed after real clicks/input: typing @ in the comment input did not show a Organization member candidate.",
      artifacts,
    };
  }
  artifacts.push(await context.writeJson("snapshots/tabdoc-comment-mention-member-candidate-visible.json", candidate));

  await context.reportProgress("TABDOC", "select mentioned member and submit comment through real clicks");
  await cdpClick(context, "tabdoc-comment-mention-member-click-candidate-cdp", "mention-candidate", prepared);
  const trailingComment = prepared.comment.text.replace(prepared.comment.expectedMentionText, "").trimStart();
  if (trailingComment) {
    await cdpInsertText(context, "tabdoc-comment-mention-member-insert-comment-tail-cdp", ` ${trailingComment}`);
  }
  await cdpClick(context, "tabdoc-comment-mention-member-click-send-comment-cdp", "send-comment", prepared);
  const commentVisible = await pollRenderer<RendererEvidence>(
    context,
    () => commentVisibleExpression(prepared),
    (value) => Boolean(value.commentVisible),
    { timeoutMs: 30_000, intervalMs: 3000, label: "submitted comment visible" },
  );
  artifacts.push(await context.writeJson("snapshots/tabdoc-comment-mention-member-comment-visible.json", commentVisible));

  const verify = await runVerifyDjango(context, prepared);
  artifacts.push(await context.writeJson("snapshots/tabdoc-comment-mention-member-backend-verify.json", verify));
  if (!verify.commentCreated || !verify.notificationCreated) {
    return {
      id: "tabdoc.comment-mention-member.type-at-select-and-notify",
      title: "通过 Electron UI 在文档评论输入 @ 选择成员并发送提醒",
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        "tabdoc.comment-mention-member failed: comment was submitted but mention persistence or mentioned-member Notification was not created.",
      artifacts,
    };
  }

  return {
    id: "tabdoc.comment-mention-member.type-at-select-and-notify",
    title: "通过 Electron UI 在文档评论输入 @ 选择成员并发送提醒",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message:
      "tabdoc.comment-mention-member passed: comment mention candidate was selected by real UI input and the mentioned member received a notification.",
    artifacts,
  };
}
