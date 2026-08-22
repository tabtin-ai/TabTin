import { pathToFileURL } from "node:url";
import type { RunContext, StepResult } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "../fixtures/electron-local-auth";
import type { ChatViewportAnchorPreparation } from "../fixtures/prepare-chat-viewport-anchor";
import { cdpClickByExpression, cdpWheelByExpression } from "./real-user-input";
import {
  assertViewportMetrics,
  computeViewportMetrics,
  type ConversationViewportFrame,
} from "../../../apps/tabtin-electron/src/renderer/src/components/chat/viewport/viewportMetrics";

type ProbeSnapshotResult = {
  ok: boolean;
  reason?: string;
  frames: unknown[];
  frameCount?: number;
  sampleErrorCount: number;
  lastSampleErrorName?: string;
};

type ViewportModeEvidence = {
  viewportMode: string | null;
  hasScroller: boolean;
  scrollToBottomVisible: boolean;
};

type AnchorEvidence = {
  sampleCount: number;
  pairCount: number;
  anchorDriftMax: number;
};

type ConvertedFrames = {
  frames: ConversationViewportFrame[];
  schemaInvalidCount: number;
  schemaErrors: string[];
};

type BaselineFrameEvidence = {
  frameNumber: number;
  rawFrame: unknown;
};

type ProbeSnapshotHealth = {
  ok: boolean;
  sampleErrorCount: unknown;
  lastSampleErrorName: unknown;
  schemaErrors: string[];
};

const ANCHOR_DRIFT_MAX_PX = 2;
const MAX_EXPAND_TARGET_WHEEL_ATTEMPTS = 8;
const EXPAND_TARGET_WHEEL_DELTA_Y = -500;
// CollapsibleMessage.tsx uses Framer Motion transition.duration = 0.2s.
// It is not exported, so the E2E contract mirrors 200ms and adds three 60Hz
// render frames for ResizeObserver / virtualizer measurement to settle.
const COLLAPSIBLE_MESSAGE_MOTION_DURATION_MS = 200;
const ANIMATION_SETTLE_SAFETY_FRAMES = 3;
const BROWSER_FRAME_BUDGET_MS = 1000 / 60;
const COLLAPSIBLE_MESSAGE_SETTLE_BUDGET_MS =
  COLLAPSIBLE_MESSAGE_MOTION_DURATION_MS
  + Math.ceil(ANIMATION_SETTLE_SAFETY_FRAMES * BROWSER_FRAME_BUDGET_MS);

function requirePreparation(context: RunContext): ChatViewportAnchorPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof data.organizationId !== "string" ||
    typeof data.userId !== "string" ||
    typeof data.spaceId !== "string" ||
    typeof data.sessionId !== "string" ||
    typeof data.longMessageId !== "string"
  ) {
    throw new Error(
      "chat.viewport-anchor-preservation requires prepared runId, organizationId, userId, spaceId, sessionId, longMessageId and marker.",
    );
  }
  return data as unknown as ChatViewportAnchorPreparation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactForProgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(redactForProgress);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /body|content|markdown|text|token|input|value/i.test(key)
      ? "<redacted>"
      : redactForProgress(item);
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
  options: { timeoutMs?: number; awaitPromise?: boolean } = {},
): T {
  const args = ["scripts/cdp-eval.mjs", expression];
  if (options.awaitPromise === false) {
    args.push("--no-await");
  }
  const result = runCommand("node", args, {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 70_000,
  });
  return JSON.parse(result.stdout.trim()) as T;
}

async function pollRenderer<T>(
  context: RunContext,
  expressionFactory: () => string,
  isDone: (value: T) => boolean | Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    try {
      last = evalRendererJson<T>(context, expressionFactory());
      if (await isDone(last)) return last;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(
        `${options.label}: renderer poll failed: ${message}`,
        { cause: error },
      );
      try {
        await context.reportProgress("ERROR", wrapped.message);
      } catch {
        // Preserve the renderer failure even if progress reporting is unavailable.
      }
      throw wrapped;
    }
    const now = Date.now();
    if (now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      await context.reportProgress(
        "WAIT",
        `${options.label} still waiting; last=${summarizeForProgress(last)}`,
      );
    }
    await sleep(options.intervalMs);
  }
  throw new Error(`Timed out waiting for ${options.label}. Last value: ${JSON.stringify(last)}`);
}

async function runAuthDjango(
  context: RunContext,
  prepared: ChatViewportAnchorPreparation,
): Promise<E2eAuthPayload> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/chat_viewport_anchor_case.py', encoding='utf-8').read())",
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
  await context.writeText("logs/chat-viewport-anchor-auth-django.log", result.stdout.replace(
    /"(accessToken|refreshToken|access_token|refresh_token)"\s*:\s*"[^"]+"/g,
    '"$1":"<redacted>"',
  ));
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, "@@E2E@@");
}

function openPreparedSessionExpression(prepared: ChatViewportAnchorPreparation): string {
  return `
(async () => {
  const prepared = ${JSON.stringify({
    organizationId: prepared.organizationId,
    userId: prepared.userId,
    spaceId: prepared.spaceId,
    sessionId: prepared.sessionId,
    longMessageId: prepared.longMessageId,
    marker: prepared.marker,
  })};
  const [
    { useChatStore },
    { useMainNavStore },
    { useSpaceViewPrefsStore },
    { useUIStore },
    { useSpaceListStore },
    { useSettingsSpaceStore },
    { useIMStore },
    { useSpaceStore },
    { useWorkbenchSceneStore },
  ] = await Promise.all([
    import('/src/stores/useChatStore.ts'),
    import('/src/stores/useMainNavStore.ts'),
    import('/src/stores/useSpaceViewPrefsStore.ts'),
    import('/src/stores/useUIStore.ts'),
    import('/src/stores/useSpaceListStore.ts'),
    import('/src/stores/useSettingsSpaceStore.ts'),
    import('/src/stores/useIMStore.ts'),
    import('/src/stores/useSpaceStore.ts'),
    import('/src/stores/useWorkbenchSceneStore.ts'),
  ]);
  useMainNavStore.getState().setCurrentTab('agent');
  useSettingsSpaceStore.getState().closeSettings();
  useIMStore.getState().closeIM();
  useIMStore.getState().setCurrentConversation(null);
  useSpaceViewPrefsStore.getState().setSidebarModeForOrganizationUser(
    prepared.organizationId,
    prepared.userId,
    'conversations',
  );
  useUIStore.getState().setChatSidePanelCollapsed(false);
  useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope('conversation:' + prepared.sessionId, true);
  const spaceStore = useSpaceStore.getState();
  if (typeof spaceStore.loadSpaces === 'function') {
    await spaceStore.loadSpaces(prepared.organizationId);
  }
  const freshSpaceStore = useSpaceStore.getState();
  const targetSpace = freshSpaceStore.spaces?.find((space) => space.id === prepared.spaceId) || null;
  if (targetSpace && typeof freshSpaceStore.selectSpace === 'function') {
    freshSpaceStore.selectSpace(targetSpace);
  }
  if (typeof useWorkbenchSceneStore.getState().activateForegroundSpace === 'function') {
    useWorkbenchSceneStore.getState().activateForegroundSpace(prepared.spaceId);
  }
  const spaces = useSpaceListStore.getState();
  if (typeof spaces.activateSpace === 'function') {
    spaces.activateSpace(prepared.spaceId);
  } else if (typeof spaces.selectSpaceBySpaceId === 'function') {
    spaces.selectSpaceBySpaceId(prepared.spaceId);
  }
  await useChatStore.getState().loadSessions(prepared.spaceId, prepared.organizationId);
  await useChatStore.getState().selectSession(prepared.spaceId, prepared.sessionId);
  if (typeof useChatStore.getState().loadSessionMessages === 'function') {
    await useChatStore.getState().loadSessionMessages(prepared.sessionId);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = useChatStore.getState();
  const messages = state.messagesBySessionId?.[prepared.sessionId] || [];
  const list = document.querySelector('[data-testid="chat-message-list"]');
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  return JSON.stringify({
    ok: true,
    sessionId: state.currentSessionIdBySpaceId?.[prepared.spaceId] ?? state.currentSessionId ?? null,
    selectedSpaceId: useSpaceStore.getState().selectedSpace?.id || null,
    messageCount: messages.length,
    longMessagePresent: messages.some((message) => message?.id === prepared.longMessageId),
    hasScroller: Boolean(scroller),
    listMessageCount: list?.getAttribute('data-message-count') ?? null,
    bodyTextTail: (document.body.innerText || '').slice(-1600),
  });
})()
`;
}

function sessionReadyExpression(prepared: ChatViewportAnchorPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify({
    spaceId: prepared.spaceId,
    sessionId: prepared.sessionId,
    longMessageId: prepared.longMessageId,
    marker: prepared.marker,
  })};
  const list = document.querySelector('[data-testid="chat-message-list"]');
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  const bodyText = document.body.innerText || '';
  const markerBubble = Array.from(
    document.querySelectorAll('[data-user-message-edit-bubble="true"]'),
  ).find((element) => {
    const text = element.innerText || element.textContent || '';
    return text.includes(prepared.marker)
      && Array.from(element.querySelectorAll('button')).some((button) =>
        /展开全文|Expand full/i.test(button.innerText || button.textContent || '')
      );
  });
  const expandButton = markerBubble
    ? Array.from(markerBubble.querySelectorAll('button')).find((button) =>
        /展开全文|Expand full/i.test(button.innerText || button.textContent || '')
      )
    : null;
  return JSON.stringify({
    ready: Boolean(
      scroller
      && list
      && Number(list.getAttribute('data-message-count') || 0) >= 2
      && (bodyText.includes(prepared.marker) || Boolean(expandButton))
    ),
    hasScroller: Boolean(scroller),
    messageCount: list?.getAttribute('data-message-count') ?? null,
    expandVisible: Boolean(expandButton),
    markerVisible: bodyText.includes(prepared.marker),
  });
})()
`;
}

function expandButtonTargetExpression(prepared: ChatViewportAnchorPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify({
    longMessageId: prepared.longMessageId,
    marker: prepared.marker,
  })};
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const center = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      label: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      tag: el.tagName,
    };
  };
  const messageIdRoot = Array.from(
    document.querySelectorAll('[data-message-id], [data-message-key]'),
  ).find((element) =>
    element.getAttribute('data-message-id') === prepared.longMessageId
    || element.getAttribute('data-message-key') === prepared.longMessageId
  );
  const markerRoot = Array.from(
    document.querySelectorAll('[data-user-message-edit-bubble="true"]'),
  ).find((element) => {
    const text = element.innerText || element.textContent || '';
    return text.includes(prepared.marker)
      && Array.from(element.querySelectorAll('button')).some((button) =>
        /展开全文|Expand full/i.test(button.innerText || button.textContent || '')
      );
  });
  const messageRoot = messageIdRoot || markerRoot;
  if (!messageRoot) {
    return JSON.stringify({
      error: 'prepared long-message container not found',
      longMessageId: prepared.longMessageId,
      marker: prepared.marker,
    });
  }
  const preferred = Array.from(messageRoot.querySelectorAll('button')).find((button) => {
    if (!isVisible(button)) return false;
    const text = (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim();
    return /展开全文|Expand full/i.test(text);
  });
  if (!preferred) {
    return JSON.stringify({
      error: 'expand-full button not found inside prepared long message',
      longMessageId: prepared.longMessageId,
      marker: prepared.marker,
    });
  }
  return JSON.stringify(center(preferred));
})()
`;
}

function chatScrollerTargetExpression(): string {
  return `
(() => {
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  if (!scroller) {
    return JSON.stringify({ error: 'chat-message-list-scroller not found' });
  }
  const rect = scroller.getBoundingClientRect();
  const style = window.getComputedStyle(scroller);
  if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none') {
    return JSON.stringify({ error: 'chat-message-list-scroller not visible', rect });
  }
  return JSON.stringify({
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    label: 'chat-message-list-scroller',
    tag: scroller.tagName,
  });
})()
`;
}

type CdpPointTarget = {
  error?: string;
  x?: number;
  y?: number;
  label?: string;
  tag?: string;
};

function isUsableCdpTarget(target: CdpPointTarget): boolean {
  return (
    !target.error
    && typeof target.x === "number"
    && Number.isFinite(target.x)
    && typeof target.y === "number"
    && Number.isFinite(target.y)
  );
}

async function revealExpandButtonWithRealWheel(
  context: RunContext,
  prepared: ChatViewportAnchorPreparation,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_EXPAND_TARGET_WHEEL_ATTEMPTS; attempt += 1) {
    const target = evalRendererJson<CdpPointTarget>(
      context,
      expandButtonTargetExpression(prepared),
    );
    if (isUsableCdpTarget(target)) return;
    if (attempt === MAX_EXPAND_TARGET_WHEEL_ATTEMPTS) {
      throw new Error(
        `expand-full button not visible after ${MAX_EXPAND_TARGET_WHEEL_ATTEMPTS} real CDP wheel attempts: ${JSON.stringify(target)}`,
      );
    }
    await cdpWheelByExpression(
      context,
      `chat-viewport-anchor-wheel-up-${attempt + 1}`,
      chatScrollerTargetExpression(),
      {
        deltaY: EXPAND_TARGET_WHEEL_DELTA_Y,
        timeoutMs: 30_000,
        targetLabel: "chat message list scroller",
      },
    );
    await sleep(250);
  }
}

function scrollToBottomTargetExpression(): string {
  return `
(() => {
  const button = document.querySelector('[data-testid="chat-scroll-to-bottom"]');
  if (!button) {
    return JSON.stringify({ error: 'chat-scroll-to-bottom button not found' });
  }
  const rect = button.getBoundingClientRect();
  const style = window.getComputedStyle(button);
  if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none') {
    return JSON.stringify({ error: 'chat-scroll-to-bottom button not visible', rect });
  }
  return JSON.stringify({
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    label: button.getAttribute('aria-label') || 'scroll-to-bottom',
    tag: button.tagName,
  });
})()
`;
}

function requireProbeAndStartExpression(prepared: ChatViewportAnchorPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify({
    sessionId: prepared.sessionId,
    longMessageId: prepared.longMessageId,
    marker: prepared.marker,
  })};
  const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__;
  if (!probe || typeof probe !== 'object') {
    return JSON.stringify({
      ok: false,
      reason: 'window.__TABTIN_CHAT_VIEWPORT_PROBE__ is missing (Phase 0 probe not bootstrapped yet)',
    });
  }
  const required = ['start', 'stop', 'reset', 'sampleNow', 'snapshot'];
  const missing = required.filter((name) => typeof probe[name] !== 'function');
  if (missing.length > 0) {
    return JSON.stringify({
      ok: false,
      reason: 'probe API incomplete',
      missing,
    });
  }
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  if (!scroller) {
    return JSON.stringify({ ok: false, reason: 'chat-message-list-scroller not found' });
  }
  const messageIdRoot = Array.from(
    document.querySelectorAll('[data-message-id], [data-message-key]'),
  ).find((element) =>
    element.getAttribute('data-message-id') === prepared.longMessageId
    || element.getAttribute('data-message-key') === prepared.longMessageId
  );
  const markerRoot = Array.from(
    document.querySelectorAll('[data-user-message-edit-bubble="true"]'),
  ).find((element) => {
    const text = element.innerText || element.textContent || '';
    return text.includes(prepared.marker)
      && Array.from(element.querySelectorAll('button')).some((button) =>
        /展开全文|Expand full/i.test(button.innerText || button.textContent || '')
      );
  });
  const messageRoot = messageIdRoot || markerRoot;
  const expandButton = messageRoot
    ? Array.from(messageRoot.querySelectorAll('button')).find((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const text = (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim();
        return (
          rect.width > 0
          && rect.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && /展开全文|Expand full/i.test(text)
        );
      })
    : null;
  const anchor = expandButton?.closest('[data-user-message-edit-bubble="true"]')
    || messageRoot
    || null;
  probe.reset();
  probe.start({
    sessionId: prepared.sessionId,
    scroller,
    anchor,
    anchorMessageKey: prepared.longMessageId,
  });
  if (typeof probe.sampleNow === 'function') probe.sampleNow();
  return JSON.stringify({
    ok: true,
    hasAnchor: Boolean(anchor),
    viewportMode: scroller.dataset.viewportMode || null,
  });
})()
`;
}

function stopProbeExpression(): string {
  return `
(() => {
  const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__;
  if (!probe || typeof probe.stop !== 'function' || typeof probe.snapshot !== 'function') {
    return JSON.stringify({
      ok: false,
      reason: 'window.__TABTIN_CHAT_VIEWPORT_PROBE__ unavailable at stop()',
      frames: [],
      sampleErrorCount: 0,
    });
  }
  let reason = '';
  let frames = [];
  let sampleErrorCount = 0;
  let lastSampleErrorName;
  try {
    if (typeof probe.sampleNow === 'function') probe.sampleNow();
  } catch (error) {
    reason = 'probe sampleNow failed: ' + (error instanceof Error ? error.message : String(error));
  }
  try {
    probe.stop();
  } catch (error) {
    reason += (reason ? '; ' : '') + 'probe stop failed: '
      + (error instanceof Error ? error.message : String(error));
  }
  try {
    const snapshot = probe.snapshot();
    frames = Array.isArray(snapshot?.frames) ? snapshot.frames : [];
    sampleErrorCount = snapshot?.sampleErrorCount;
    lastSampleErrorName = snapshot?.lastSampleErrorName;
  } catch (error) {
    reason += (reason ? '; ' : '') + 'probe snapshot failed: '
      + (error instanceof Error ? error.message : String(error));
  }
  return JSON.stringify({
    ok: !reason,
    reason: reason || undefined,
    frames,
    frameCount: frames.length,
    sampleErrorCount,
    ...(lastSampleErrorName !== undefined ? { lastSampleErrorName } : {}),
  });
})()
`;
}

function probeSnapshotExpression(): string {
  return `
(() => {
  const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__;
  if (!probe || typeof probe.snapshot !== 'function') {
    return JSON.stringify({
      ok: false,
      reason: 'window.__TABTIN_CHAT_VIEWPORT_PROBE__ unavailable at snapshot()',
      frames: [],
      sampleErrorCount: 0,
    });
  }
  try {
    if (typeof probe.sampleNow === 'function') probe.sampleNow();
    const snapshot = probe.snapshot();
    const frames = Array.isArray(snapshot?.frames) ? snapshot.frames : [];
    return JSON.stringify({
      ok: true,
      frames,
      frameCount: frames.length,
      sampleErrorCount: snapshot?.sampleErrorCount,
      ...(snapshot?.lastSampleErrorName !== undefined
        ? { lastSampleErrorName: snapshot.lastSampleErrorName }
        : {}),
    });
  } catch (error) {
    let frames = [];
    let sampleErrorCount = 0;
    let lastSampleErrorName;
    try {
      const fallback = probe.snapshot();
      frames = Array.isArray(fallback?.frames) ? fallback.frames : [];
      sampleErrorCount = fallback?.sampleErrorCount;
      lastSampleErrorName = fallback?.lastSampleErrorName;
    } catch {}
    return JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      frames,
      frameCount: frames.length,
      sampleErrorCount,
      ...(lastSampleErrorName !== undefined ? { lastSampleErrorName } : {}),
    });
  }
})()
`;
}

function viewportModeExpression(): string {
  return `
(() => {
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  const button = document.querySelector('[data-testid="chat-scroll-to-bottom"]');
  return JSON.stringify({
    viewportMode: scroller?.dataset?.viewportMode ?? null,
    hasScroller: Boolean(scroller),
    scrollToBottomVisible: Boolean(button),
  });
})()
`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function diagnosticValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value || "empty-string";
  try {
    const serialized = JSON.stringify(value);
    if (serialized) return serialized.slice(0, 160);
  } catch {
    // Fall through to String(value) for non-serializable renderer values.
  }
  return String(value).slice(0, 160);
}

function isInvalidProbeMode(value: unknown): value is `invalid:${string}` {
  return typeof value === "string" && value.startsWith("invalid:");
}

function normalizeProbeMode(
  value: unknown,
  errors: string[],
): ConversationViewportFrame["mode"] {
  if (value === "follow-latest" || value === "anchored-reading") return value;
  if (isInvalidProbeMode(value)) return value;
  const invalidMode: `invalid:${string}` = `invalid:${diagnosticValue(value)}`;
  errors.push(`mode is missing or unsupported: ${diagnosticValue(value)}`);
  return invalidMode;
}

function convertProbeFrames(rawFrames: unknown[]): ConvertedFrames {
  const frames: ConversationViewportFrame[] = [];
  const schemaErrors: string[] = [];
  let schemaInvalidCount = 0;
  const validSources = new Set([
    "user",
    "programmatic",
    "browser-clamp",
    "virtualizer",
    "unknown",
  ]);

  for (let index = 0; index < rawFrames.length; index += 1) {
    const value = rawFrames[index];
    const raw = value && typeof value === "object"
      ? value as Record<string, unknown>
      : {};
    const errors: string[] = [];
    const requiredNumber = (field: string): number => {
      const candidate = raw[field];
      if (!isFiniteNumber(candidate)) {
        errors.push(`${field} must be finite`);
        return Number.NaN;
      }
      return candidate;
    };
    const requiredString = (field: string, fallback: string): string => {
      const candidate = raw[field];
      if (typeof candidate !== "string") {
        errors.push(`${field} must be a string`);
        return fallback;
      }
      return candidate;
    };
    const optionalNumber = (field: string): number | undefined => {
      const candidate = raw[field];
      if (candidate === undefined) return undefined;
      if (!isFiniteNumber(candidate)) {
        errors.push(`${field} must be finite when present`);
        return Number.NaN;
      }
      return candidate;
    };

    const mode = normalizeProbeMode(raw.mode, errors);

    const rawSource = requiredString("source", "unknown");
    const source = validSources.has(rawSource)
      ? rawSource as ConversationViewportFrame["source"]
      : "unknown";
    if (!validSources.has(rawSource)) errors.push(`source is unsupported: ${rawSource}`);

    const anchorMessageKey = raw.anchorMessageKey;
    if (anchorMessageKey !== undefined && typeof anchorMessageKey !== "string") {
      errors.push("anchorMessageKey must be a string when present");
    }

    const targetOffset = optionalNumber("targetOffset");
    const followError = optionalNumber("followError");
    const anchorTop = optionalNumber("anchorTop");
    const frame: ConversationViewportFrame = {
      ts: requiredNumber("ts"),
      frame: requiredNumber("frame"),
      sessionId: requiredString("sessionId", ""),
      mode,
      reason: requiredString("reason", "invalid-runtime-frame"),
      source,
      scrollTop: requiredNumber("scrollTop"),
      scrollHeight: requiredNumber("scrollHeight"),
      clientHeight: requiredNumber("clientHeight"),
      writesThisFrame: requiredNumber("writesThisFrame"),
      ...(targetOffset !== undefined ? { targetOffset } : {}),
      ...(followError !== undefined ? { followError } : {}),
      ...(typeof anchorMessageKey === "string" ? { anchorMessageKey } : {}),
      ...(anchorTop !== undefined ? { anchorTop } : {}),
    };
    if (errors.length > 0) {
      schemaInvalidCount += 1;
      schemaErrors.push(`frame ${index}: ${errors.join(", ")}`);
    }
    frames.push(frame);
  }

  return { frames, schemaInvalidCount, schemaErrors };
}

function computeExpectedAnchorEvidence(
  frames: ConversationViewportFrame[],
  expectedAnchorMessageKey: string,
  minimumExclusiveFrame?: number,
): AnchorEvidence {
  let sampleCount = 0;
  let pairCount = 0;
  let anchorDriftMax = 0;

  for (let index = 0; index < frames.length; index += 1) {
    const current = frames[index];
    const currentInScope =
      minimumExclusiveFrame === undefined || current.frame > minimumExclusiveFrame;
    if (
      currentInScope
      && current.anchorMessageKey === expectedAnchorMessageKey
      && isFiniteNumber(current.anchorTop)
    ) {
      sampleCount += 1;
    }
    if (index === 0) continue;
    const previous = frames[index - 1];
    const previousInScope =
      minimumExclusiveFrame === undefined || previous.frame > minimumExclusiveFrame;
    if (
      !previousInScope
      || !currentInScope
      || previous.anchorMessageKey !== expectedAnchorMessageKey
      || current.anchorMessageKey !== expectedAnchorMessageKey
      || !isFiniteNumber(previous.anchorTop)
      || !isFiniteNumber(current.anchorTop)
    ) {
      continue;
    }
    pairCount += 1;
    anchorDriftMax = Math.max(
      anchorDriftMax,
      Math.abs(current.anchorTop - previous.anchorTop),
    );
  }

  return { sampleCount, pairCount, anchorDriftMax };
}

function validateProbeSnapshotHealth(snapshot: ProbeSnapshotResult): ProbeSnapshotHealth {
  const rawCount: unknown = snapshot.sampleErrorCount;
  const rawName: unknown = snapshot.lastSampleErrorName;
  const schemaErrors: string[] = [];
  if (
    !isFiniteNumber(rawCount)
    || !Number.isInteger(rawCount)
    || rawCount < 0
  ) {
    schemaErrors.push("sampleErrorCount must be a finite nonnegative integer");
  }
  if (rawName !== undefined && typeof rawName !== "string") {
    schemaErrors.push("lastSampleErrorName must be a string when present");
  }
  return {
    ok: schemaErrors.length === 0 && rawCount === 0,
    sampleErrorCount: rawCount,
    lastSampleErrorName: rawName,
    schemaErrors,
  };
}

async function requireHealthyProbeSnapshot(
  context: RunContext,
  snapshot: ProbeSnapshotResult,
  phase: string,
): Promise<void> {
  const health = validateProbeSnapshotHealth(snapshot);
  if (health.ok) return;
  await writeProbeErrorsArtifact(context, health, phase);
  throw new Error(
    `viewport probe sample errors at ${phase}: ${JSON.stringify({
      sampleErrorCount: health.sampleErrorCount,
      lastSampleErrorName: health.lastSampleErrorName,
      schemaErrors: health.schemaErrors,
    })}`,
  );
}

async function writeProbeErrorsArtifact(
  context: RunContext,
  health: ProbeSnapshotHealth,
  phase: string,
): Promise<void> {
  await context.writeJson(
    "snapshots/chat-viewport-anchor-probe-errors.json",
    {
      phase,
      sampleErrorCount: health.sampleErrorCount,
      ...(health.lastSampleErrorName !== undefined
        ? { lastSampleErrorName: health.lastSampleErrorName }
        : {}),
      schemaErrors: health.schemaErrors,
    },
  );
}

function readBaselineFrame(
  snapshot: ProbeSnapshotResult,
  expectedAnchorMessageKey: string,
): BaselineFrameEvidence {
  if (!snapshot.ok) {
    throw new Error(snapshot.reason ?? "baseline viewport probe snapshot failed");
  }
  const last = snapshot.frames[snapshot.frames.length - 1];
  const raw = last && typeof last === "object"
    ? last as Record<string, unknown>
    : null;
  const frame = raw?.frame;
  const anchorMessageKey = raw?.anchorMessageKey;
  const anchorTop = raw?.anchorTop;
  if (
    !isFiniteNumber(frame)
    || anchorMessageKey !== expectedAnchorMessageKey
    || !isFiniteNumber(anchorTop)
  ) {
    throw new Error(
      `baseline viewport probe requires latest frame with expected anchor and finite top: ${JSON.stringify({
        frameCount: snapshot.frames.length,
        expectedAnchorMessageKey,
        lastFrame: last ?? null,
      })}`,
    );
  }
  return { frameNumber: frame, rawFrame: last };
}

function rawFramesAfterBaseline(rawFrames: unknown[], baselineFrame: number): unknown[] {
  const firstPostClickIndex = rawFrames.findIndex((value) => {
    if (!value || typeof value !== "object") return false;
    return isFiniteNumber((value as Record<string, unknown>).frame)
      && ((value as Record<string, unknown>).frame as number) > baselineFrame;
  });
  return firstPostClickIndex >= 0 ? rawFrames.slice(firstPostClickIndex) : [];
}

export function hasSufficientPostClickAnchorEvidence(
  rawFrames: unknown[],
  expectedAnchorMessageKey: string,
  baselineFrameNumber: number,
): boolean {
  const converted = convertProbeFrames(rawFrames);
  const evidence = computeExpectedAnchorEvidence(
    converted.frames,
    expectedAnchorMessageKey,
    baselineFrameNumber,
  );
  return evidence.sampleCount >= 2 && evidence.pairCount > 0;
}

export function buildChatViewportMetricsArtifact(
  baselineRawFrame: unknown,
  postClickRawFrames: unknown[],
  expectedAnchorMessageKey: string,
  baselineFrameNumber: number,
  modeAfterExpand: string | null | undefined,
  modeAfterScrollToBottom: string | null | undefined,
): {
  convertedFrames: ConversationViewportFrame[];
  artifact: Record<string, unknown> & { ok: boolean; failureReason?: string };
} {
  const metricsInput = [baselineRawFrame, ...postClickRawFrames];
  const converted = convertProbeFrames(metricsInput);
  const productMetrics = computeViewportMetrics(converted.frames);
  const assertion = assertViewportMetrics(productMetrics, "anchored-reading");
  const anchorEvidence = computeExpectedAnchorEvidence(
    converted.frames,
    expectedAnchorMessageKey,
  );
  const postClickEvidence = computeExpectedAnchorEvidence(
    converted.frames,
    expectedAnchorMessageKey,
    baselineFrameNumber,
  );
  const failures: string[] = [];
  if (converted.schemaInvalidCount > 0) {
    failures.push(
      `runtime schema invalid frames expected 0, received ${converted.schemaInvalidCount}`,
    );
  }
  if (postClickEvidence.sampleCount < 2) {
    failures.push(
      `expected at least 2 post-click explicit finite samples for ${expectedAnchorMessageKey}, received ${postClickEvidence.sampleCount}`,
    );
  }
  if (anchorEvidence.pairCount === 0) {
    failures.push(
      `expected at least one adjacent explicit pair for ${expectedAnchorMessageKey}`,
    );
  }
  if (postClickEvidence.pairCount === 0) {
    failures.push(
      `expected at least one post-click adjacent explicit pair for ${expectedAnchorMessageKey}`,
    );
  }
  if (productMetrics.invalidSampleCount > 0) {
    failures.push(
      `product invalidSampleCount expected 0, received ${productMetrics.invalidSampleCount}`,
    );
  }
  if ("violations" in assertion) {
    failures.push(...assertion.violations);
  }
  if (modeAfterExpand !== "anchored-reading") {
    failures.push(
      `modeAfterExpand expected anchored-reading, received ${String(modeAfterExpand)}`,
    );
  }
  if (modeAfterScrollToBottom !== "follow-latest") {
    failures.push(
      `modeAfterScrollToBottom expected follow-latest, received ${String(modeAfterScrollToBottom)}`,
    );
  }

  return {
    convertedFrames: converted.frames,
    artifact: {
      productMetrics,
      assertion,
      sampleCount: anchorEvidence.sampleCount,
      pairCount: anchorEvidence.pairCount,
      postClickSampleCount: postClickEvidence.sampleCount,
      postClickPairCount: postClickEvidence.pairCount,
      expectedAnchorDriftMax: anchorEvidence.anchorDriftMax,
      baselineFrameNumber,
      metricsInputCount: metricsInput.length,
      runtimeSchemaInvalidCount: converted.schemaInvalidCount,
      runtimeSchemaErrors: converted.schemaErrors,
      convertedModes: converted.frames.map((frame, index) => ({
        index,
        frame: frame.frame,
        mode: frame.mode,
      })),
      metricsInputFrames: converted.frames,
      threshold: ANCHOR_DRIFT_MAX_PX,
      modeAfterExpand: modeAfterExpand ?? null,
      modeAfterScrollToBottom: modeAfterScrollToBottom ?? null,
      ok: failures.length === 0,
      ...(failures.length > 0 ? { failureReason: failures.join("; ") } : {}),
    },
  };
}

/** Green-only fixture frames for static scroll-mode contract (no live Electron). */
function makeGreenAnchorFixtureFrames(anchorKey: string): {
  baseline: unknown;
  postClick: unknown[];
  baselineFrameNumber: number;
} {
  const baseline = {
    ts: 0,
    frame: 1,
    sessionId: "static-scroll-mode-contract",
    mode: "anchored-reading",
    reason: "user-browse-up",
    source: "user",
    scrollTop: 200,
    scrollHeight: 2000,
    clientHeight: 600,
    anchorMessageKey: anchorKey,
    anchorTop: 120,
    writesThisFrame: 0,
  };
  const postClick = [
    {
      ts: 16,
      frame: 2,
      sessionId: "static-scroll-mode-contract",
      mode: "anchored-reading",
      reason: "content-resize",
      source: "unknown",
      scrollTop: 220,
      scrollHeight: 2200,
      clientHeight: 600,
      anchorMessageKey: anchorKey,
      anchorTop: 120,
      writesThisFrame: 0,
    },
    {
      ts: 32,
      frame: 3,
      sessionId: "static-scroll-mode-contract",
      mode: "anchored-reading",
      reason: "streaming-tick",
      source: "unknown",
      scrollTop: 240,
      scrollHeight: 2400,
      clientHeight: 600,
      anchorMessageKey: anchorKey,
      anchorTop: 120.5,
      writesThisFrame: 0,
    },
  ];
  return { baseline, postClick, baselineFrameNumber: 1 };
}

/**
 * Static regression: metrics may be all green, but wrong
 * modeAfterScrollToBottom must still fail ok (symmetric with modeAfterExpand).
 * Run: `pnpm exec tsx tests/electron/actions/chat-viewport.ts`
 */
export function assertChatViewportMetricsScrollModeContract(): void {
  const anchorKey = "message-expand-static";
  const { baseline, postClick, baselineFrameNumber } =
    makeGreenAnchorFixtureFrames(anchorKey);

  const wrong = buildChatViewportMetricsArtifact(
    baseline,
    postClick,
    anchorKey,
    baselineFrameNumber,
    "anchored-reading",
    "anchored-reading",
  );
  if (wrong.artifact.ok) {
    throw new Error(
      "expected ok=false when modeAfterScrollToBottom is anchored-reading (other metrics green)",
    );
  }
  if (wrong.artifact.modeAfterScrollToBottom !== "anchored-reading") {
    throw new Error(
      `expected artifact to retain wrong modeAfterScrollToBottom, received ${String(wrong.artifact.modeAfterScrollToBottom)}`,
    );
  }
  const reason = String(wrong.artifact.failureReason ?? "");
  if (!reason.includes("modeAfterScrollToBottom expected follow-latest")) {
    throw new Error(
      `expected explicit modeAfterScrollToBottom failure reason, received ${reason}`,
    );
  }

  const okResult = buildChatViewportMetricsArtifact(
    baseline,
    postClick,
    anchorKey,
    baselineFrameNumber,
    "anchored-reading",
    "follow-latest",
  );
  if (!okResult.artifact.ok) {
    throw new Error(
      `expected ok=true when modeAfterScrollToBottom is follow-latest, received ${okResult.artifact.failureReason}`,
    );
  }
}

function stopProbeWithFallback(
  context: RunContext,
  fallbackSnapshot: ProbeSnapshotResult,
): ProbeSnapshotResult {
  try {
    return evalRendererJson<ProbeSnapshotResult>(context, stopProbeExpression());
  } catch (error) {
    return {
      ok: false,
      reason:
        `CDP probe stop/snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      frames: fallbackSnapshot.frames,
      frameCount: fallbackSnapshot.frames.length,
      sampleErrorCount: fallbackSnapshot.sampleErrorCount,
      ...(fallbackSnapshot.lastSampleErrorName !== undefined
        ? { lastSampleErrorName: fallbackSnapshot.lastSampleErrorName }
        : {}),
    };
  }
}

function finallyStopProbeExpression(): string {
  return `
(() => {
  const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__;
  if (!probe || typeof probe.stop !== 'function') {
    return JSON.stringify({
      ok: false,
      reason: 'window.__TABTIN_CHAT_VIEWPORT_PROBE__ unavailable during finally cleanup',
      frames: [],
      sampleErrorCount: 0,
    });
  }
  let reason = '';
  let frames = [];
  let sampleErrorCount = 0;
  let lastSampleErrorName;
  try {
    probe.stop();
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  try {
    const snapshot = typeof probe.snapshot === 'function' ? probe.snapshot() : null;
    frames = Array.isArray(snapshot?.frames) ? snapshot.frames : [];
    sampleErrorCount = snapshot?.sampleErrorCount;
    lastSampleErrorName = snapshot?.lastSampleErrorName;
  } catch (error) {
    reason += (reason ? '; ' : '') + (error instanceof Error ? error.message : String(error));
  }
  return JSON.stringify({
    ok: !reason,
    reason: reason || undefined,
    frames,
    frameCount: frames.length,
    sampleErrorCount,
    ...(lastSampleErrorName !== undefined ? { lastSampleErrorName } : {}),
  });
})()
`;
}

async function reportCleanupFailure(context: RunContext, message: string): Promise<void> {
  try {
    await context.reportProgress("CLEANUP", message);
  } catch {
    // Cleanup reporting must never replace the original scenario failure.
  }
}

async function bestEffortRestoreFollowLatest(context: RunContext): Promise<void> {
  try {
    const mode = evalRendererJson<ViewportModeEvidence>(context, viewportModeExpression());
    if (mode.viewportMode === "follow-latest") return;
    const target = evalRendererJson<CdpPointTarget>(context, scrollToBottomTargetExpression());
    if (!isUsableCdpTarget(target)) {
      throw new Error(`scroll-to-bottom cleanup target unavailable: ${JSON.stringify(target)}`);
    }
    await cdpClickByExpression(
      context,
      "chat-viewport-anchor-finally-scroll-to-bottom-cdp",
      scrollToBottomTargetExpression(),
      { timeoutMs: 15_000, targetLabel: "chat-scroll-to-bottom cleanup" },
    );
  } catch (error) {
    await reportCleanupFailure(
      context,
      `best-effort follow-latest cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runChatViewportAnchorPreservation(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);

  artifacts.push(
    await context.writeJson("snapshots/chat-viewport-anchor-action-input.json", {
      runId: context.runId,
      scenarioId: context.scenarioId,
      prepared: {
        organizationId: prepared.organizationId,
        userId: prepared.userId,
        spaceId: prepared.spaceId,
        sessionId: prepared.sessionId,
        longMessageId: prepared.longMessageId,
        marker: prepared.marker,
        messageCount: prepared.messageCount,
      },
      requiredUiActions: [
        "real CDP click expand-full on long user message",
        "real CDP click chat-scroll-to-bottom",
      ],
      expandAnimationBudget: {
        source:
          "CollapsibleMessage.tsx motion transition duration=0.2s; plus three 60Hz render frames",
        motionDurationMs: COLLAPSIBLE_MESSAGE_MOTION_DURATION_MS,
        safetyFrames: ANIMATION_SETTLE_SAFETY_FRAMES,
        settleBudgetMs: COLLAPSIBLE_MESSAGE_SETTLE_BUDGET_MS,
      },
    }),
  );

  await context.reportProgress("AUTH", "bootstrap local auth for viewport anchor session");
  const authPayload = await runAuthDjango(context, prepared);
  await saveElectronAuthPayload(context, authPayload, "chat-viewport-anchor");

  await context.reportProgress("CHAT", "open prepared Space/session via renderer store helpers");
  const openResult = evalRendererJson<{
    ok: boolean;
    sessionId?: string | null;
    selectedSpaceId?: string | null;
    messageCount?: number;
    hasScroller?: boolean;
  }>(context, openPreparedSessionExpression(prepared), { timeoutMs: 90_000 });
  artifacts.push(await context.writeJson("snapshots/chat-viewport-anchor-open-session.json", openResult));
  if (!openResult.ok || openResult.selectedSpaceId !== prepared.spaceId) {
    throw new Error(`Failed to open prepared chat session: ${JSON.stringify(openResult)}`);
  }

  const ready = await pollRenderer<{
    ready: boolean;
    hasScroller: boolean;
    expandVisible: boolean;
    markerVisible: boolean;
  }>(
    context,
    () => sessionReadyExpression(prepared),
    (value) => value.ready,
    { timeoutMs: 90_000, intervalMs: 2500, label: "chat viewport session ready" },
  );
  artifacts.push(await context.writeJson("snapshots/chat-viewport-anchor-session-ready.json", ready));

  await context.reportProgress("UI", "locate long message with readonly probe or real CDP wheel");
  await revealExpandButtonWithRealWheel(context, prepared);

  await context.reportProgress("PROBE", "start readonly viewport probe around long message anchor");
  const probeStart = evalRendererJson<{
    ok: boolean;
    reason?: string;
    missing?: string[];
    hasAnchor?: boolean;
    viewportMode?: string | null;
  }>(context, requireProbeAndStartExpression(prepared));
  artifacts.push(await context.writeJson("snapshots/chat-viewport-anchor-probe-start.json", probeStart));
  if (!probeStart.ok) {
    throw new Error(
      `chat.viewport-anchor-preservation requires window.__TABTIN_CHAT_VIEWPORT_PROBE__: ${JSON.stringify(probeStart)}`,
    );
  }

  let latestSnapshot: ProbeSnapshotResult = {
    ok: true,
    frames: [],
    frameCount: 0,
    sampleErrorCount: 0,
  };
  let framesArtifactWritten = false;
  let primaryError: unknown;
  try {
    const baselineSnapshot = evalRendererJson<ProbeSnapshotResult>(
      context,
      probeSnapshotExpression(),
    );
    latestSnapshot = baselineSnapshot;
    await requireHealthyProbeSnapshot(context, baselineSnapshot, "baseline");
    const baseline = readBaselineFrame(
      baselineSnapshot,
      prepared.longMessageId,
    );
    const baselineFrame = baseline.frameNumber;
    artifacts.push(
      await context.writeJson(
        "snapshots/chat-viewport-anchor-baseline.json",
        {
          baselineFrameNumber: baselineFrame,
          frameCount: baselineSnapshot.frames.length,
          latestFrame: baselineSnapshot.frames[baselineSnapshot.frames.length - 1],
          sampleErrorCount: baselineSnapshot.sampleErrorCount,
          ...(baselineSnapshot.lastSampleErrorName !== undefined
            ? { lastSampleErrorName: baselineSnapshot.lastSampleErrorName }
            : {}),
        },
      ),
    );

    await context.reportProgress("UI", "real CDP click expand-full on long user message");
    await cdpClickByExpression(
      context,
      "chat-viewport-anchor-expand-full-cdp",
      expandButtonTargetExpression(prepared),
      { timeoutMs: 45_000, targetLabel: "expand-full" },
    );

    await sleep(COLLAPSIBLE_MESSAGE_SETTLE_BUDGET_MS);

    const settledSnapshot = await pollRenderer<ProbeSnapshotResult>(
      context,
      () => probeSnapshotExpression(),
      async (value) => {
        latestSnapshot = value;
        await requireHealthyProbeSnapshot(context, value, "post-click-poll");
        if (!value.ok) {
          throw new Error(value.reason ?? "viewport probe snapshot failed");
        }
        return hasSufficientPostClickAnchorEvidence(
          value.frames,
          prepared.longMessageId,
          baselineFrame,
        );
      },
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        label: "post-click viewport probe samples and adjacent anchor pair after expand",
      },
    );
    latestSnapshot = settledSnapshot;

    const modeAfterExpand = evalRendererJson<ViewportModeEvidence>(
      context,
      viewportModeExpression(),
    );
    artifacts.push(
      await context.writeJson(
        "snapshots/chat-viewport-anchor-mode-after-expand.json",
        modeAfterExpand,
      ),
    );

    const probeStop = stopProbeWithFallback(context, latestSnapshot);
    latestSnapshot = probeStop;
    const framesPath = await context.writeJson(
      "snapshots/chat-viewport-anchor-frames.json",
      probeStop,
    );
    artifacts.push(framesPath);
    framesArtifactWritten = true;
    await requireHealthyProbeSnapshot(context, probeStop, "stop");
    if (!probeStop.ok) {
      throw new Error(`viewport probe stop/snapshot failed: ${JSON.stringify(probeStop)}`);
    }
    const postClickFrames = rawFramesAfterBaseline(
      probeStop.frames,
      baselineFrame,
    );

    const metricsResult = buildChatViewportMetricsArtifact(
      baseline.rawFrame,
      postClickFrames,
      prepared.longMessageId,
      baselineFrame,
      modeAfterExpand.viewportMode,
      // Expand-only checkpoint: scroll restore not executed yet. Final rebuild
      // below re-asserts with the real polled modeAfterScrollToBottom.
      "follow-latest",
    );
    const metricsPath = await context.writeJson(
      "snapshots/chat-viewport-anchor-metrics.json",
      metricsResult.artifact,
    );
    artifacts.push(metricsPath);
    if (!metricsResult.artifact.ok) {
      throw new Error(
        `anchored viewport metrics failed: ${
          metricsResult.artifact.failureReason ?? JSON.stringify(metricsResult.artifact)
        }`,
      );
    }

    await context.reportProgress("UI", "real CDP click scroll-to-bottom to restore follow-latest");
    await pollRenderer<ViewportModeEvidence>(
      context,
      () => viewportModeExpression(),
      (value) => Boolean(value.scrollToBottomVisible),
      { timeoutMs: 30_000, intervalMs: 1000, label: "scroll-to-bottom button visible" },
    );
    await cdpClickByExpression(
      context,
      "chat-viewport-anchor-scroll-to-bottom-cdp",
      scrollToBottomTargetExpression(),
      { timeoutMs: 30_000, targetLabel: "chat-scroll-to-bottom" },
    );

    const modeAfterScrollToBottom = await pollRenderer<ViewportModeEvidence>(
      context,
      () => viewportModeExpression(),
      (value) => value.viewportMode === "follow-latest",
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        label: "viewportMode follow-latest after scroll-to-bottom",
      },
    );
    artifacts.push(
      await context.writeJson(
        "snapshots/chat-viewport-anchor-mode-after-scroll-to-bottom.json",
        modeAfterScrollToBottom,
      ),
    );

    const finalMetrics = buildChatViewportMetricsArtifact(
      baseline.rawFrame,
      postClickFrames,
      prepared.longMessageId,
      baselineFrame,
      modeAfterExpand.viewportMode,
      modeAfterScrollToBottom.viewportMode,
    );
    await context.writeJson(
      "snapshots/chat-viewport-anchor-metrics.json",
      finalMetrics.artifact,
    );
    if (!finalMetrics.artifact.ok) {
      throw new Error(
        `final anchored viewport metrics failed: ${
          finalMetrics.artifact.failureReason ?? JSON.stringify(finalMetrics.artifact)
        }`,
      );
    }

    return {
      id: "chat.viewport-anchor-preservation.expand-and-restore",
      title: "真实点击展开长消息并断言阅读锚点，再点击回到底部恢复跟随",
      status: "passed",
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        `Expanded long message with authoritative anchored metrics; scroll-to-bottom restored follow-latest.`,
      artifacts,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupSampleFailure: Error | undefined;
    let cleanupStop: ProbeSnapshotResult;
    try {
      cleanupStop = evalRendererJson<ProbeSnapshotResult>(
        context,
        finallyStopProbeExpression(),
      );
    } catch (error) {
      cleanupStop = {
        ok: false,
        reason:
          `finally probe stop failed: ${error instanceof Error ? error.message : String(error)}`,
        frames: latestSnapshot.frames,
        frameCount: latestSnapshot.frames.length,
        sampleErrorCount: latestSnapshot.sampleErrorCount,
        ...(latestSnapshot.lastSampleErrorName !== undefined
          ? { lastSampleErrorName: latestSnapshot.lastSampleErrorName }
          : {}),
      };
    }
    if (!framesArtifactWritten) {
      try {
        await context.writeJson(
          "snapshots/chat-viewport-anchor-frames.json",
          cleanupStop,
        );
      } catch (error) {
        await reportCleanupFailure(
          context,
          `failed to write cleanup probe evidence: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!cleanupStop.ok) {
      await reportCleanupFailure(
        context,
        `best-effort probe stop failed: ${cleanupStop.reason ?? "unknown reason"}`,
      );
    }
    const cleanupHealth = validateProbeSnapshotHealth(cleanupStop);
    if (!cleanupHealth.ok) {
      try {
        await writeProbeErrorsArtifact(context, cleanupHealth, "finally-stop");
      } catch (error) {
        await reportCleanupFailure(
          context,
          `failed to write probe error evidence: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await reportCleanupFailure(
        context,
        `probe sampling errors observed during finally cleanup: ${JSON.stringify({
          sampleErrorCount: cleanupHealth.sampleErrorCount,
          lastSampleErrorName: cleanupHealth.lastSampleErrorName,
          schemaErrors: cleanupHealth.schemaErrors,
        })}`,
      );
      if (primaryError === undefined) {
        cleanupSampleFailure = new Error(
          `viewport probe sample errors during finally cleanup: ${JSON.stringify({
            sampleErrorCount: cleanupHealth.sampleErrorCount,
            lastSampleErrorName: cleanupHealth.lastSampleErrorName,
            schemaErrors: cleanupHealth.schemaErrors,
          })}`,
        );
      }
    }
    await bestEffortRestoreFollowLatest(context);
    if (cleanupSampleFailure) throw cleanupSampleFailure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertChatViewportMetricsScrollModeContract();
  console.log("PASS chat-viewport metrics scroll-mode contract");
}
