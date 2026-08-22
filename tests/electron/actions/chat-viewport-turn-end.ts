import { pathToFileURL } from "node:url";
import type { RunContext, StepResult } from "../runner/types";
import {
  CommandExecutionError,
  parseJsonSentinel,
  resolvePythonCommand,
  runCommand,
} from "../runner/process";
import { saveElectronAuthPayload, type E2eAuthPayload } from "../fixtures/electron-local-auth";
import type { ChatViewportTurnEndPreparation } from "../fixtures/prepare-chat-viewport-turn-end";
import {
  assertViewportMetrics,
  computeViewportMetrics,
  type ConversationViewportFrame,
} from "../../../apps/tabtin-electron/src/renderer/src/components/chat/viewport/viewportMetrics";

/**
 * Fixed Chinese prompt asking for one observable Agent turn:
 * thinking + >=4 tools + a final artifact. Driven only via real composer CDP.
 */
export const TURN_END_OBSERVABLE_PROMPT =
  "请在当前 Space 完成一轮可观察任务：先简短思考你的计划，然后连续执行至少 4 个工具步骤" +
  "（例如列出目录、读取文件、创建文档、追加内容），最后产出一个可见产物（文档或文件）。" +
  "不要只回复文字，必须真正调用工具并留下产物。";

/** When agentReady=true, composer still disabled after this window is a product FAIL. */
export const COMPOSER_READY_TIMEOUT_MS = 20_000;

const TURN_END_SETTLE_MS = 500;
const STREAMING_WAIT_TIMEOUT_MS = 180_000;
const STRUCTURE_MIN_THINKING = 1;
const STRUCTURE_MIN_TOOLS = 4;
const STRUCTURE_MIN_ARTIFACTS = 1;

export type TurnEndSendResult = {
  ok: boolean;
  reason?: string;
  bodyTextTail?: string;
};

export type TurnEndSendFailureKind = "environment-unavailable" | "product-failure";

/** Pure gate: only absence of a selected existing execution Space may skip. */
export function shouldSkipForUnavailableExecutionSpace(prepared: {
  usesExistingExecutionSpace?: boolean;
}): boolean {
  return prepared.usesExistingExecutionSpace === false;
}

/**
 * Narrow recognition of environment/provider misconfiguration from sendResult.
 * Unknown failures stay product FAIL — do not broadly swallow exceptions.
 */
export function classifySendFailure(
  sendResult: TurnEndSendResult,
): TurnEndSendFailureKind | null {
  if (sendResult.ok) return null;
  const haystack = `${sendResult.reason ?? ""}\n${sendResult.bodyTextTail ?? ""}`;
  const environmentPatterns = [
    /environment-unavailable/i,
    /api[_\s-]?key/i,
    /missing[_\s-]?api[_\s-]?key/i,
    /provider.{0,40}(not\s+configured|unavailable|missing)/i,
    /model.{0,40}(not\s+configured|unavailable|missing)/i,
    /no\s+provider/i,
    /llm.{0,40}(not\s+configured|unavailable)/i,
    /未配置.{0,12}(模型|密钥|API|provider)/i,
    /缺少.{0,12}(API\s*Key|密钥|模型)/i,
  ];
  if (environmentPatterns.some((pattern) => pattern.test(haystack))) {
    return "environment-unavailable";
  }
  return "product-failure";
}

/**
 * Static contract: no candidate → skip; fully ready existing Space → continue;
 * composer timeout/unknown send errors remain product failures.
 * Run: `pnpm exec tsx tests/electron/actions/chat-viewport-turn-end.ts`
 */
export function assertTurnEndAgentGateContract(): void {
  if (!shouldSkipForUnavailableExecutionSpace({ usesExistingExecutionSpace: false })) {
    throw new Error("expected no existing execution Space candidate to skip");
  }
  if (shouldSkipForUnavailableExecutionSpace({ usesExistingExecutionSpace: true })) {
    throw new Error("expected selected existing execution Space to continue");
  }
  if (shouldSkipForUnavailableExecutionSpace({})) {
    throw new Error("expected malformed preparation to NOT auto-skip");
  }
  if (COMPOSER_READY_TIMEOUT_MS !== 20_000) {
    throw new Error(`expected COMPOSER_READY_TIMEOUT_MS=20000, got ${COMPOSER_READY_TIMEOUT_MS}`);
  }
  // A selected candidate reaches the 20s poll. Timeout throws and is never
  // rewritten as skipped; this proves composer-disabled remains product FAIL.
  const envSkip = classifySendFailure({
    ok: false,
    reason: "LLM provider not configured",
    bodyTextTail: "Missing API key for chat model",
  });
  if (envSkip !== "environment-unavailable") {
    throw new Error(`expected environment-unavailable for provider misconfig, got ${envSkip}`);
  }
  const productFail = classifySendFailure({
    ok: false,
    reason: "TARGET_COMPOSER_NOT_READY",
    bodyTextTail: "composer still disabled for unknown wiring reason",
  });
  if (productFail !== "product-failure") {
    throw new Error(`expected product-failure for unknown send error, got ${productFail}`);
  }
  if (classifySendFailure({ ok: true }) !== null) {
    throw new Error("expected ok sendResult to classify as null");
  }

  const frame = (
    frameNumber: number,
    reason: ConversationViewportFrame["reason"],
    scrollTop: number,
  ): ConversationViewportFrame => ({
    ts: frameNumber * 16,
    frame: frameNumber,
    sessionId: "contract-session",
    mode: "follow-latest",
    reason,
    source: "programmatic",
    scrollTop,
    scrollHeight: scrollTop + 600,
    clientHeight: 600,
    writesThisFrame: 1,
    targetOffset: scrollTop,
    followError: 0,
  });
  const missingTurnEnd = buildFollowLatestMetricsArtifact([
    frame(1, "streaming-tick", 100),
    frame(2, "message-appended", 104),
  ]);
  if (missingTurnEnd.artifact.ok || missingTurnEnd.artifact.turnEndSampleCount !== 0) {
    throw new Error("expected metrics artifact without turn-ended frame to fail coverage gate");
  }
  const observedTurnEnd = buildFollowLatestMetricsArtifact([
    frame(1, "streaming-tick", 100),
    frame(2, "turn-ended", 124),
  ]);
  if (!observedTurnEnd.artifact.ok || observedTurnEnd.artifact.turnEndSampleCount !== 1) {
    throw new Error("expected metrics artifact with turn-ended frame to pass coverage gate");
  }
}

type ProbeSnapshotResult = {
  ok: boolean;
  reason?: string;
  frames: unknown[];
  frameCount?: number;
  sampleErrorCount: number;
  lastSampleErrorName?: string;
};

type ConvertedFrames = {
  frames: ConversationViewportFrame[];
  schemaInvalidCount: number;
  schemaErrors: string[];
};

type TurnStructureEvidence = {
  thinkingCount: number;
  toolStepCount: number;
  artifactCount: number;
  assistantMessageCount: number;
  streaming: boolean;
  structureOk: boolean;
  reasons: string[];
};

function requirePreparation(context: RunContext): ChatViewportTurnEndPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof data.selectionStrategy !== "string" ||
    typeof data.usesExistingExecutionSpace !== "boolean" ||
    typeof data.agentReady !== "boolean" ||
    typeof data.deviceReady !== "boolean" ||
    typeof data.workingDirReady !== "boolean" ||
    typeof data.preferredModelReady !== "boolean" ||
    typeof data.membershipReady !== "boolean" ||
    typeof data.membershipProvisioned !== "boolean" ||
    typeof data.organizationMemberReady !== "boolean"
  ) {
    throw new Error(
      "chat.viewport-turn-end-stability requires execution-Space selection and readiness fields.",
    );
  }
  if (
    data.usesExistingExecutionSpace &&
    !(
      typeof data.organizationId === "string" &&
      typeof data.userId === "string" &&
      typeof data.spaceId === "string" &&
      typeof data.sessionId === "string" &&
      typeof data.agentId === "string" &&
      typeof data.deviceId === "string" &&
      data.agentReady &&
      data.deviceReady &&
      data.workingDirReady &&
      data.preferredModelReady &&
      data.membershipReady &&
      data.organizationMemberReady
    )
  ) {
    throw new Error(
      "chat.viewport-turn-end-stability selected existing Space is not fully executable.",
    );
  }
  return data as unknown as ChatViewportTurnEndPreparation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactForProgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(redactForProgress);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /body|content|markdown|text|token|input|value|prompt/i.test(key)
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
  prepared: ChatViewportTurnEndPreparation,
): Promise<E2eAuthPayload> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/chat_viewport_turn_end_case.py', encoding='utf-8').read())",
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
    "logs/chat-viewport-turn-end-auth-django.log",
    result.stdout.replace(
      /"(accessToken|refreshToken|access_token|refresh_token)"\s*:\s*"[^"]+"/g,
      '"$1":"<redacted>"',
    ),
  );
  return parseJsonSentinel<E2eAuthPayload>(result.stdout, "@@E2E@@");
}

function openPreparedSessionExpression(prepared: ChatViewportTurnEndPreparation): string {
  return `
(async () => {
  const prepared = ${JSON.stringify({
    organizationId: prepared.organizationId,
    userId: prepared.userId,
    spaceId: prepared.spaceId,
    sessionId: prepared.sessionId,
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
  // activateForegroundSpace / selectSession can race the active-Space resolver.
  // Force both the per-Space and global pointers so ChatContent leaves draft mode.
  useChatStore.getState().setCurrentSessionForSpace(
    prepared.spaceId,
    prepared.sessionId,
    true,
  );
  if (typeof useChatStore.getState().loadSessionMessages === 'function') {
    await useChatStore.getState().loadSessionMessages(prepared.sessionId);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = useChatStore.getState();
  const messages = state.messagesBySessionId?.[prepared.sessionId] || [];
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  const textarea = document.querySelector(
    'textarea[data-chat-input-textarea="true"][data-session-id="' + prepared.sessionId + '"]'
  ) || document.querySelector(
    'textarea[data-chat-input-textarea="true"][data-space-id="' + prepared.spaceId + '"]'
  );
  const selectedSpace = useSpaceStore.getState().selectedSpace || targetSpace;
  const agentId =
    (typeof selectedSpace?.agent_id === 'string' && selectedSpace.agent_id)
    || (typeof selectedSpace?.agentId === 'string' && selectedSpace.agentId)
    || (typeof selectedSpace?.agent?.id === 'string' && selectedSpace.agent.id)
    || null;
  return JSON.stringify({
    ok: true,
    sessionId: state.currentSessionIdBySpaceId?.[prepared.spaceId] ?? state.currentSessionId ?? null,
    selectedSpaceId: useSpaceStore.getState().selectedSpace?.id || null,
    agentId,
    messageCount: messages.length,
    hasScroller: Boolean(scroller),
    hasComposer: Boolean(textarea),
  });
})()
`;
}

function composerReadyExpression(prepared: ChatViewportTurnEndPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify({
    spaceId: prepared.spaceId,
    sessionId: prepared.sessionId,
  })};
  const selector = 'textarea[data-chat-input-textarea="true"][data-session-id="' + prepared.sessionId + '"]';
  const textarea = document.querySelector(selector);
  const composers = Array.from(
    document.querySelectorAll('textarea[data-chat-input-textarea="true"]'),
  ).map((item) => ({
    sessionId: item.getAttribute('data-session-id'),
    spaceId: item.getAttribute('data-space-id'),
    disabled: Boolean(item.disabled || item.readOnly),
  }));
  if (!textarea) {
    return JSON.stringify({
      ready: false,
      hasTextarea: false,
      visible: false,
      disabled: true,
      composers,
    });
  }
  const rect = textarea.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0;
  return JSON.stringify({
    ready: visible && !textarea.disabled && !textarea.readOnly,
    hasTextarea: true,
    visible,
    disabled: Boolean(textarea.disabled || textarea.readOnly),
    composers,
  });
})()
`;
}

function messageListReadyExpression(): string {
  return `
(() => {
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  const list = document.querySelector('[data-testid="chat-message-list"]');
  return JSON.stringify({
    ready: Boolean(scroller),
    hasScroller: Boolean(scroller),
    messageCount: list?.getAttribute('data-message-count') || null,
  });
})()
`;
}

function submitTurnEndPrompt(
  context: RunContext,
  prepared: ChatViewportTurnEndPreparation,
): TurnEndSendResult {
  try {
    const result = runCommand(
      "node",
      [
        "scripts/cdp-submit-chat-composer.mjs",
        JSON.stringify({
          sessionId: prepared.sessionId,
          spaceId: prepared.spaceId,
          marker: prepared.marker,
          messageText: TURN_END_OBSERVABLE_PROMPT,
        }),
      ],
      {
        cwd: context.repoRoot,
        timeoutMs: 60_000,
      },
    );
    return JSON.parse(result.stdout.trim()) as TurnEndSendResult;
  } catch (error) {
    // CDP script exits 1 after printing JSON when ok=false. Recover sendResult
    // from stdout only — do not broadly convert arbitrary exceptions into skip.
    if (error instanceof CommandExecutionError) {
      const lastLine = error.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine) as TurnEndSendResult;
          if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
            return parsed;
          }
        } catch {
          // Fall through to rethrow.
        }
      }
    }
    throw error;
  }
}

function streamingStateExpression(prepared: ChatViewportTurnEndPreparation): string {
  return `
(async () => {
  const prepared = ${JSON.stringify({ sessionId: prepared.sessionId })};
  const { useChatStore } = await import('/src/stores/useChatStore.ts');
  const state = useChatStore.getState();
  const streaming = Boolean(state.streamingBySessionId?.[prepared.sessionId]);
  const messages = state.messagesBySessionId?.[prepared.sessionId] || [];
  return JSON.stringify({
    streaming,
    messageCount: messages.length,
    hasAssistant: messages.some((message) => message?.role === 'assistant'),
  });
})()
`;
}

function turnStructureExpression(prepared: ChatViewportTurnEndPreparation): string {
  return `
(async () => {
  const prepared = ${JSON.stringify({ sessionId: prepared.sessionId })};
  const mins = ${JSON.stringify({
    thinking: STRUCTURE_MIN_THINKING,
    tools: STRUCTURE_MIN_TOOLS,
    artifacts: STRUCTURE_MIN_ARTIFACTS,
  })};
  const { useChatStore } = await import('/src/stores/useChatStore.ts');
  const state = useChatStore.getState();
  const streaming = Boolean(state.streamingBySessionId?.[prepared.sessionId]);
  const messages = state.messagesBySessionId?.[prepared.sessionId] || [];
  const readBlocks = (message) => {
    const raw =
      Array.isArray(message?.blocks) && message.blocks.length > 0
        ? message.blocks
        : Array.isArray(message?.content_blocks_json)
          ? message.content_blocks_json
          : Array.isArray(message?.blocks_json)
            ? message.blocks_json
            : [];
    return raw.map((entry) => (
      entry
      && typeof entry === 'object'
      && entry.block
      && typeof entry.block === 'object'
        ? entry.block
        : entry
    ));
  };
  let thinkingCount = 0;
  let toolStepCount = 0;
  let artifactCount = 0;
  let assistantMessageCount = 0;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    assistantMessageCount += 1;
    if ((message.message_kind || 'llm') === 'tool_artifact') artifactCount += 1;
    const blocks = readBlocks(message);
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const type = block.type;
      if (type === 'thinking' || type === 'redacted_thinking') thinkingCount += 1;
      if (type === 'tool_use' || type === 'mcp_tool_use' || type === 'server_tool_use') {
        toolStepCount += 1;
      }
      if (
        type === 'tabtin_rich_content'
        || type === 'document'
        || type === 'code_artifact_v3'
        || type === 'rich_content'
        || block.artifact_kind === 'local_file'
      ) {
        artifactCount += 1;
      }
      if (
        type === 'tool_use'
        && typeof block.name === 'string'
        && /write_file|edit_file|create.*doc|tabdoc|tabdata/i.test(block.name)
      ) {
        artifactCount += 1;
      }
    }
  }
  const reasons = [];
  if (thinkingCount < mins.thinking) {
    reasons.push('thinkingCount < ' + mins.thinking + ' (got ' + thinkingCount + ')');
  }
  if (toolStepCount < mins.tools) {
    reasons.push('toolStepCount < ' + mins.tools + ' (got ' + toolStepCount + ')');
  }
  if (artifactCount < mins.artifacts) {
    reasons.push('artifactCount < ' + mins.artifacts + ' (got ' + artifactCount + ')');
  }
  return JSON.stringify({
    thinkingCount,
    toolStepCount,
    artifactCount,
    assistantMessageCount,
    streaming,
    structureOk: reasons.length === 0,
    reasons,
  });
})()
`;
}

function requireProbeAndStartExpression(prepared: ChatViewportTurnEndPreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify({ sessionId: prepared.sessionId })};
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
    return JSON.stringify({ ok: false, reason: 'probe API incomplete', missing });
  }
  const scroller = document.querySelector('[data-testid="chat-message-list-scroller"]');
  if (!scroller) {
    return JSON.stringify({ ok: false, reason: 'chat-message-list-scroller not found' });
  }
  probe.reset();
  probe.start({ sessionId: prepared.sessionId, scroller });
  if (typeof probe.sampleNow === 'function') probe.sampleNow();
  return JSON.stringify({
    ok: true,
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
  probe.stop();
  const snapshot = probe.snapshot();
  return JSON.stringify({
    ok: true,
    frames: snapshot?.frames || [],
    frameCount: Array.isArray(snapshot?.frames) ? snapshot.frames.length : 0,
    sampleErrorCount: typeof snapshot?.sampleErrorCount === 'number' ? snapshot.sampleErrorCount : 0,
    ...(typeof snapshot?.lastSampleErrorName === 'string'
      ? { lastSampleErrorName: snapshot.lastSampleErrorName }
      : {}),
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
    // Fall through.
  }
  return String(value).slice(0, 160);
}

function normalizeProbeMode(
  value: unknown,
  errors: string[],
): ConversationViewportFrame["mode"] {
  if (value === "follow-latest" || value === "anchored-reading") return value;
  if (typeof value === "string" && value.startsWith("invalid:")) {
    return value as `invalid:${string}`;
  }
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

    const targetOffset = optionalNumber("targetOffset");
    const followError = optionalNumber("followError");
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
    };
    if (errors.length > 0) {
      schemaInvalidCount += 1;
      schemaErrors.push(`frame ${index}: ${errors.join(", ")}`);
    }
    frames.push(frame);
  }

  return { frames, schemaInvalidCount, schemaErrors };
}

export function buildFollowLatestMetricsArtifact(rawFrames: unknown[]): {
  convertedFrames: ConversationViewportFrame[];
  artifact: Record<string, unknown> & { ok: boolean; failureReason?: string };
} {
  const converted = convertProbeFrames(rawFrames);
  const productMetrics = computeViewportMetrics(converted.frames);
  const assertion = assertViewportMetrics(productMetrics, "follow-latest");
  const turnEndSampleCount = converted.frames.filter(
    (frame) => frame.reason === "turn-ended",
  ).length;
  const failures: string[] = [];
  if (converted.schemaInvalidCount > 0) {
    failures.push(
      `runtime schema invalid frames expected 0, received ${converted.schemaInvalidCount}`,
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
  if (turnEndSampleCount === 0) {
    failures.push("turn-ended frame coverage expected at least 1 sample, received 0");
  }
  return {
    convertedFrames: converted.frames,
    artifact: {
      productMetrics,
      assertion,
      metricsInputCount: rawFrames.length,
      runtimeSchemaInvalidCount: converted.schemaInvalidCount,
      runtimeSchemaErrors: converted.schemaErrors,
      metricsInputFrames: converted.frames,
      profile: "follow-latest",
      turnEndJumpMaxThreshold: 24,
      turnEndSampleCount,
      ok: failures.length === 0,
      ...(failures.length > 0 ? { failureReason: failures.join("; ") } : {}),
    },
  };
}

function skippedResult(
  startedAt: string,
  message: string,
  artifacts: string[],
): StepResult {
  return {
    id: "chat.viewport-turn-end-stability.run-and-assert",
    title: "真实发送 Agent 任务并断言 follow-latest turn-end 视口稳定性",
    status: "skipped",
    startedAt,
    endedAt: new Date().toISOString(),
    message,
    artifacts,
  };
}

export async function runChatViewportTurnEndStability(
  context: RunContext,
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const artifacts: string[] = [];
  const prepared = requirePreparation(context);

  artifacts.push(
    await context.writeJson("snapshots/chat-viewport-turn-end-action-input.json", {
      runId: context.runId,
      scenarioId: context.scenarioId,
      prepared: {
        organizationId: prepared.organizationId,
        userId: prepared.userId,
        spaceId: prepared.spaceId,
        sessionId: prepared.sessionId,
        marker: prepared.marker,
        agentId: prepared.agentId,
        deviceId: prepared.deviceId,
        agentReady: prepared.agentReady,
        deviceReady: prepared.deviceReady,
        workingDirReady: prepared.workingDirReady,
        preferredModelReady: prepared.preferredModelReady,
        membershipReady: prepared.membershipReady,
        membershipProvisioned: prepared.membershipProvisioned,
        organizationMemberReady: prepared.organizationMemberReady,
        usesExistingExecutionSpace: prepared.usesExistingExecutionSpace,
        selectionStrategy: prepared.selectionStrategy,
        messageCount: prepared.messageCount,
      },
      requiredUiActions: [
        "real CDP composer type + submit fixed Chinese observable-agent prompt",
      ],
      structureGate: {
        thinking: STRUCTURE_MIN_THINKING,
        tools: STRUCTURE_MIN_TOOLS,
        artifacts: STRUCTURE_MIN_ARTIFACTS,
        onInsufficient: "step status skipped (environment/model structure unavailable)",
      },
      agentGate: {
        onNoExistingExecutionSpace:
          "step status skipped (environment-unavailable) before auth/composer open",
        composerReadyTimeoutMs: COMPOSER_READY_TIMEOUT_MS,
        onComposerDisabled: "product FAIL (not skip)",
      },
    }),
  );

  if (shouldSkipForUnavailableExecutionSpace(prepared)) {
    artifacts.push(
      await context.writeJson("snapshots/chat-viewport-turn-end-environment.json", {
        skipReason: "no-ready-existing-execution-space",
        selectionStrategy: prepared.selectionStrategy,
        agentId: prepared.agentId,
        deviceId: prepared.deviceId,
        agentReady: prepared.agentReady,
        deviceReady: prepared.deviceReady,
        workingDirReady: prepared.workingDirReady,
        preferredModelReady: prepared.preferredModelReady,
        membershipReady: prepared.membershipReady,
        membershipProvisioned: prepared.membershipProvisioned,
        organizationMemberReady: prepared.organizationMemberReady,
        note: "No existing Space satisfied the live execution readiness contract.",
      }),
    );
    await context.reportProgress(
      "SKIP",
      "environment-unavailable: no ready existing execution Space",
    );
    return skippedResult(
      startedAt,
      "environment-unavailable: no existing personal Space has an active Agent/model, online execution device, working_dir, and active user memberships. Not a product FAIL.",
      artifacts,
    );
  }

  await context.reportProgress("AUTH", "bootstrap local auth for viewport turn-end session");
  const authPayload = await runAuthDjango(context, prepared);
  await saveElectronAuthPayload(context, authPayload, "chat-viewport-turn-end");

  await context.reportProgress("CHAT", "open prepared Space/session via renderer store helpers");
  const openResult = evalRendererJson<{
    ok: boolean;
    sessionId?: string | null;
    selectedSpaceId?: string | null;
    agentId?: string | null;
    hasScroller?: boolean;
    hasComposer?: boolean;
  }>(context, openPreparedSessionExpression(prepared), { timeoutMs: 90_000 });
  artifacts.push(
    await context.writeJson("snapshots/chat-viewport-turn-end-open-session.json", openResult),
  );
  if (!openResult.ok || openResult.selectedSpaceId !== prepared.spaceId) {
    throw new Error(`Failed to open prepared chat session: ${JSON.stringify(openResult)}`);
  }
  const openedAgentId = openResult.agentId ?? null;
  if (openedAgentId !== prepared.agentId) {
    throw new Error(
      `chat.viewport-turn-end-stability agentId mismatch (fixture/product data): prepared=${JSON.stringify(prepared.agentId)} open=${JSON.stringify(openedAgentId)}`,
    );
  }

  const composerReady = await pollRenderer<{
    ready: boolean;
    hasTextarea: boolean;
    visible: boolean;
    disabled: boolean;
  }>(
    context,
    () => composerReadyExpression(prepared),
    (value) => value.ready,
    {
      timeoutMs: COMPOSER_READY_TIMEOUT_MS,
      intervalMs: 1000,
      label: "chat composer ready for turn-end",
    },
  );
  artifacts.push(
    await context.writeJson(
      "snapshots/chat-viewport-turn-end-composer-ready.json",
      composerReady,
    ),
  );

  let framesWritten = false;
  let probeStarted = false;
  try {
    await context.reportProgress(
      "UI",
      "real CDP composer submit fixed Chinese observable Agent prompt",
    );
    const sendResult = submitTurnEndPrompt(context, prepared);
    artifacts.push(
      await context.writeJson(
        "snapshots/chat-viewport-turn-end-send-result.json",
        {
          ok: sendResult.ok,
          reason: sendResult.reason,
          // Never persist prompt body in evidence.
          promptChars: TURN_END_OBSERVABLE_PROMPT.length,
          failureKind: sendResult.ok ? null : classifySendFailure(sendResult),
        },
      ),
    );
    if (!sendResult.ok) {
      const failureKind = classifySendFailure(sendResult);
      if (failureKind === "environment-unavailable") {
        artifacts.push(
          await context.writeJson("snapshots/chat-viewport-turn-end-environment.json", {
            skipReason: "provider-or-model-unavailable",
            sendReason: sendResult.reason ?? null,
            // Redact body text; only record that env pattern matched.
            bodyTextInspected: Boolean(sendResult.bodyTextTail),
            note: "sendResult clearly indicates external provider/model not configured.",
          }),
        );
        await context.reportProgress(
          "SKIP",
          `environment-unavailable: ${sendResult.reason ?? "provider/model not configured"}`,
        );
        return skippedResult(
          startedAt,
          `environment-unavailable: external provider/model not configured before send (${sendResult.reason ?? "unknown"}). Not a product FAIL.`,
          artifacts,
        );
      }
      throw new Error(`Chat composer send failed: ${JSON.stringify(sendResult)}`);
    }

    // Empty sessions intentionally render MessageList's empty state without the
    // virtualized scroller. Real composer submission mounts it with the first
    // optimistic user message; start the probe immediately after that boundary.
    const messageListReady = await pollRenderer<{
      ready: boolean;
      hasScroller: boolean;
      messageCount: string | null;
    }>(
      context,
      () => messageListReadyExpression(),
      (value) => value.ready,
      {
        timeoutMs: COMPOSER_READY_TIMEOUT_MS,
        intervalMs: 100,
        label: "chat message list scroller after first real submit",
      },
    );
    artifacts.push(
      await context.writeJson(
        "snapshots/chat-viewport-turn-end-message-list-ready.json",
        messageListReady,
      ),
    );

    await context.reportProgress(
      "PROBE",
      "start readonly viewport probe after first real message mounted the scroller",
    );
    const probeStart = evalRendererJson<{
      ok: boolean;
      reason?: string;
      viewportMode?: string | null;
    }>(context, requireProbeAndStartExpression(prepared));
    artifacts.push(
      await context.writeJson("snapshots/chat-viewport-turn-end-probe-start.json", probeStart),
    );
    if (!probeStart.ok) {
      throw new Error(
        `chat.viewport-turn-end-stability requires window.__TABTIN_CHAT_VIEWPORT_PROBE__: ${JSON.stringify(probeStart)}`,
      );
    }
    probeStarted = true;

    await context.reportProgress("WAIT", "wait for streaming true then false + settle");
    await pollRenderer<{ streaming: boolean; hasAssistant: boolean }>(
      context,
      () => streamingStateExpression(prepared),
      (value) => value.streaming === true || value.hasAssistant,
      {
        timeoutMs: STREAMING_WAIT_TIMEOUT_MS,
        intervalMs: 2000,
        label: "agent streaming start or first assistant message",
      },
    );
    await pollRenderer<{ streaming: boolean }>(
      context,
      () => streamingStateExpression(prepared),
      (value) => value.streaming === false,
      {
        timeoutMs: STREAMING_WAIT_TIMEOUT_MS,
        intervalMs: 2000,
        label: "agent streaming false (turn settled signal)",
      },
    );
    await sleep(TURN_END_SETTLE_MS);

    const structure = evalRendererJson<TurnStructureEvidence>(
      context,
      turnStructureExpression(prepared),
    );
    artifacts.push(
      await context.writeJson(
        "snapshots/chat-viewport-turn-end-structure.json",
        structure,
      ),
    );

    const probeStop = evalRendererJson<ProbeSnapshotResult>(
      context,
      stopProbeExpression(),
    );
    const framesPath = await context.writeJson(
      "snapshots/chat-viewport-turn-end-frames.json",
      probeStop,
    );
    artifacts.push(framesPath);
    framesWritten = true;

    if (!structure.structureOk) {
      await context.reportProgress(
        "SKIP",
        `external-model structure unavailable: ${structure.reasons.join("; ")}`,
      );
      return skippedResult(
        startedAt,
        `environment-unavailable: Agent turn structure insufficient for viewport turn-end assertion (${structure.reasons.join("; ")}). Not a product FAIL.`,
        artifacts,
      );
    }

    if (!probeStop.ok) {
      throw new Error(`viewport probe stop/snapshot failed: ${JSON.stringify(probeStop)}`);
    }
    if (probeStop.sampleErrorCount > 0) {
      throw new Error(
        `viewport probe sampleErrorCount expected 0, received ${probeStop.sampleErrorCount}`,
      );
    }

    const metricsResult = buildFollowLatestMetricsArtifact(probeStop.frames);
    const metricsPath = await context.writeJson(
      "snapshots/chat-viewport-turn-end-metrics.json",
      metricsResult.artifact,
    );
    artifacts.push(metricsPath);
    if (!metricsResult.artifact.ok) {
      throw new Error(
        `follow-latest viewport metrics failed: ${
          metricsResult.artifact.failureReason ?? JSON.stringify(metricsResult.artifact)
        }`,
      );
    }

    return {
      id: "chat.viewport-turn-end-stability.run-and-assert",
      title: "真实发送 Agent 任务并断言 follow-latest turn-end 视口稳定性",
      status: "passed",
      startedAt,
      endedAt: new Date().toISOString(),
      message:
        "Agent turn structure satisfied; follow-latest metrics including turnEndJumpMax<=24 passed.",
      artifacts,
    };
  } finally {
    if (probeStarted && !framesWritten) {
      try {
        const fallback = evalRendererJson<ProbeSnapshotResult>(
          context,
          stopProbeExpression(),
        );
        artifacts.push(
          await context.writeJson(
            "snapshots/chat-viewport-turn-end-frames.json",
            fallback,
          ),
        );
      } catch {
        // Best-effort probe cleanup evidence only.
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertTurnEndAgentGateContract();
  console.log("PASS chat-viewport-turn-end agent-gate contract");
}
