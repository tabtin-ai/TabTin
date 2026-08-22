import type { RunContext, StepResult } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import type { ChatMessagePersistencePreparation } from "../fixtures/prepare-chat-message-persistence";
import { readElectronChatSession } from "../fixtures/electron-chat-session";

type PersistedChatMessage = {
  messageId: string;
  sessionId: string;
  role: string;
  textSummary: string;
  marker?: string;
  spaceId?: string;
  clientEventId?: string;
  queriedSessionId?: string | null;
  queriedMessageId?: string | null;
};

type RendererMessageEvidence = {
  currentSessionId: string | null;
  expectedSessionId: string;
  expectedMessageId: string;
  messageCount: number;
  foundById: boolean;
  foundByMarker: boolean;
  bodyIncludesMarker: boolean;
  matchedMessage?: {
    id: string;
    role?: string;
    contentPreview: string;
  };
  messageIds: string[];
  bodyTextTail: string;
};

function requireChatPreparation(context: RunContext): ChatMessagePersistencePreparation {
  const data = context.preparedData;
  if (
    typeof data.marker !== "string" ||
    typeof data.messageText !== "string" ||
    typeof data.spaceId !== "string" ||
    typeof data.sessionId !== "string"
  ) {
    throw new Error("chat.message-persistence requires prepared marker, messageText, spaceId and sessionId.");
  }
  return data as unknown as ChatMessagePersistencePreparation;
}

function evalJson<T>(
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
    timeoutMs: options.timeoutMs ?? 70000,
  });
  return JSON.parse(result.stdout.trim()) as T;
}

function summarizeForProgress(value: unknown): string {
  const text = JSON.stringify(redactForProgress(value));
  if (!text) return "no observation yet";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
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

async function verifyChatMessagePersisted(
  context: RunContext,
  prepared: ChatMessagePersistencePreparation,
  options: { messageId?: string | null; sessionId?: string | null } = {},
): Promise<PersistedChatMessage> {
  const deadline = Date.now() + 90000;
  let lastError = "Chat message was not persisted yet.";
  const runVerify = (sessionId?: string | null) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TABTIN_E2E_MARKER: prepared.marker,
      TABTIN_E2E_SPACE_ID: prepared.spaceId,
    };
    if (sessionId) {
      env.TABTIN_E2E_SESSION_ID = sessionId;
    }
    if (options.messageId) {
      env.TABTIN_E2E_MESSAGE_ID = options.messageId;
    }

    const djangoResult = runCommand(
      resolvePythonCommand(context.repoRoot),
      [
        "apps/tabtin_django/manage.py",
        "shell",
        "-c",
        "exec(open('tests/electron/fixtures/chat_message_persistence_verify.py', encoding='utf-8').read())",
      ],
      {
        cwd: context.repoRoot,
        timeoutMs: 60000,
        env,
      },
    );
    return parseJsonSentinel<PersistedChatMessage>(
      djangoResult.stdout,
      "@@E2E@@",
    );
  };

  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    try {
      return runVerify(options.sessionId);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const now = Date.now();
    if (now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      await context.reportProgress(
        "WAIT",
        `chat message persistence still waiting; last=${lastError.slice(0, 500)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  await context.writeText("logs/chat-message-postgresql-verify-last-error.log", lastError);
  throw new Error(lastError);
}

async function pollRenderer<T>(
  context: RunContext,
  expressionFactory: () => string,
  isDone: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs: number; label?: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    last = evalJson<T>(context, expressionFactory());
    if (isDone(last)) return last;
    const now = Date.now();
    if (options.timeoutMs >= 10000 && now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      await context.reportProgress(
        "WAIT",
        `${options.label ?? "renderer condition"} still waiting; last=${summarizeForProgress(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new Error(`Timed out waiting for renderer condition. Last value: ${JSON.stringify(last)}`);
}

function chatComposerReadyExpression(
  prepared: ChatMessagePersistencePreparation,
  targetSessionId: string | null,
): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const targetSessionId = ${JSON.stringify(targetSessionId)};
  const selector = targetSessionId
    ? 'textarea[data-chat-input-textarea="true"][data-session-id="' + targetSessionId + '"]'
    : 'textarea[data-chat-input-textarea="true"][data-space-id="' + prepared.spaceId + '"][data-session-id=""]';
  const textarea = document.querySelector(selector);
  const rect = textarea?.getBoundingClientRect?.();
  const visible = Boolean(textarea && rect && rect.width > 0 && rect.height > 0);
  const disabled = Boolean(textarea?.disabled || textarea?.readOnly);
  const bodyText = document.body.innerText || '';
  const composers = Array.from(document.querySelectorAll('textarea[data-chat-input-textarea="true"]')).map((item) => ({
    sessionId: item.getAttribute('data-session-id'),
    spaceId: item.getAttribute('data-space-id'),
    disabled: item.disabled,
    readOnly: item.readOnly,
  }));
  return JSON.stringify({
    ready: visible && !disabled,
    hasTextarea: Boolean(textarea),
    visible,
    disabled,
    composers,
    currentSpaceVisible: bodyText.includes(prepared.spaceId) || bodyText.includes(prepared.marker) || bodyText.includes('[e2e-chat]'),
    bodyTextTail: bodyText.slice(-1200),
  });
})()
`;
}

function openPreparedSessionExpression(
  prepared: ChatMessagePersistencePreparation,
  targetSessionId: string | null,
): string {
  return `
(async () => {
  const prepared = ${JSON.stringify(prepared)};
  const targetSessionId = ${JSON.stringify(targetSessionId)};
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
  const clearE2eQueue = async () => {
    const chatState = useChatStore.getState();
    const queue = Array.isArray(chatState.messageQueue) ? chatState.messageQueue : [];
    const nextQueue = queue.filter((item) => {
      const itemSessionId = item?.sessionId ?? null;
      const itemSpaceId = item?.spaceId ?? null;
      const content = typeof item?.content === 'string' ? item.content : '';
      const targetsPreparedSession = itemSessionId === prepared.sessionId;
      const targetsPreparedSpace = itemSpaceId === prepared.spaceId;
      const hasNoExplicitSession = itemSessionId === null || itemSessionId === undefined || itemSessionId === '';
      const looksLikeE2eMessage = content.includes(prepared.marker) || content.includes('E2E persistence check');
      return !(targetsPreparedSession || targetsPreparedSpace || (hasNoExplicitSession && looksLikeE2eMessage));
    });
    if (nextQueue.length !== queue.length) {
      useChatStore.setState({ messageQueue: nextQueue });
      try {
        if (nextQueue.length === 0) {
          sessionStorage.removeItem('tabtin:messageQueue');
        } else {
          sessionStorage.setItem('tabtin:messageQueue', JSON.stringify(nextQueue));
        }
      } catch {}
      try {
        const openReq = indexedDB.open('tabtin-offline-queue', 1);
        const db = await new Promise((resolve) => {
          openReq.onsuccess = () => resolve(openReq.result);
          openReq.onerror = () => resolve(null);
          openReq.onupgradeneeded = () => {
            const db = openReq.result;
            if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
          };
        });
        if (db) {
          await new Promise((resolve) => {
            const tx = db.transaction('queue', 'readwrite');
            const store = tx.objectStore('queue');
            store.clear();
            for (const item of nextQueue) store.put(item);
            tx.oncomplete = () => resolve(undefined);
            tx.onerror = () => resolve(undefined);
          });
          db.close();
        }
      } catch {}
    }
    return queue.length - nextQueue.length;
  };
  const removedQueueCount = await clearE2eQueue();
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
  const chat = useChatStore.getState();
  await chat.loadSessions(prepared.spaceId, prepared.organizationId);
  if (targetSessionId) {
    await useChatStore.getState().selectSession(prepared.spaceId, targetSessionId);
  } else if (typeof useChatStore.getState().startDraftSessionForSpace === 'function') {
    useChatStore.getState().startDraftSessionForSpace(prepared.spaceId);
  } else if (typeof useChatStore.getState().setCurrentSessionForSpace === 'function') {
    useChatStore.getState().setCurrentSessionForSpace(prepared.spaceId, null);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = useChatStore.getState();
  return JSON.stringify({
    ok: true,
    sessionId: state.currentSessionIdBySpaceId?.[prepared.spaceId] ?? state.currentSessionId ?? null,
    selectedSpaceId: useSpaceStore.getState().selectedSpace?.id || null,
    targetSpaceFound: Boolean(targetSpace),
    visible: document.body.innerText.includes(prepared.marker),
    messageCount: targetSessionId ? (state.messagesBySessionId?.[targetSessionId]?.length ?? 0) : 0,
    removedQueueCount,
    remainingQueueCount: state.messageQueue?.length ?? 0,
    sidebarMode: useSpaceViewPrefsStore.getState().getSidebarMode(prepared.organizationId, prepared.userId),
    bodyTextTail: document.body.innerText.slice(-1600)
  });
})()
`;
}

function markerDomEvidenceExpression(marker: string): string {
  return `
(() => {
  const marker = ${JSON.stringify(marker)};
  const bodyText = document.body.innerText || '';
  const list = document.querySelector('[data-testid="chat-message-list"]');
  return JSON.stringify({
    visible: bodyText.includes(marker),
    messageCount: list?.getAttribute('data-message-count') ?? null,
    virtualRowCount: list?.getAttribute('data-virtual-row-count') ?? null,
    isForeground: list?.getAttribute('data-is-foreground') ?? null,
    bodyTextTail: bodyText.slice(-2000)
  });
})()
`;
}

function submitMessageThroughComposer(
  context: RunContext,
  prepared: ChatMessagePersistencePreparation,
  targetSessionId: string | null,
): {
  ok: boolean;
  beforeValue?: string;
  focusedBeforeSubmit?: boolean;
  inputCleared?: boolean;
  currentSessionId?: string | null;
  messageCount?: number;
  sentInStore?: boolean;
  bodyTextTail?: string;
  reason?: string;
} {
  const result = runCommand(
    "node",
    [
      "scripts/cdp-submit-chat-composer.mjs",
      JSON.stringify({
        sessionId: targetSessionId ?? "",
        spaceId: prepared.spaceId,
        marker: prepared.marker,
        messageText: prepared.messageText,
      }),
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
    },
  );
  return JSON.parse(result.stdout.trim());
}

function rendererMessageEvidenceExpression(
  prepared: ChatMessagePersistencePreparation,
  expectedMessage: PersistedChatMessage,
): string {
  return `
(async () => {
  const prepared = ${JSON.stringify(prepared)};
  const expected = ${JSON.stringify(expectedMessage)};
  const { useChatStore } = await import('/src/stores/useChatStore.ts');
  const extractText = (message) => {
    const parts = [];
    for (const value of [message?.content, message?.text_summary, message?.textSummary]) {
      if (typeof value === 'string' && value) parts.push(value);
    }
    const blocks = message?.content_blocks_json || message?.blocks_json || [];
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    return parts.join('\\n');
  };

  const store = useChatStore.getState();
  if (typeof store.loadSessionMessages === 'function' && store.messagesBySessionId?.[prepared.sessionId] === undefined) {
    await store.loadSessionMessages(prepared.sessionId);
  }
  const state = useChatStore.getState();
  const messages = state.messagesBySessionId?.[prepared.sessionId] || [];
  const matchedById = messages.find((message) => message?.id === expected.messageId) || null;
  const matchedByMarker = messages.find((message) => extractText(message).includes(prepared.marker)) || null;
  const matched = matchedById || matchedByMarker;
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    currentSessionId: state.currentSessionIdBySpaceId?.[prepared.spaceId] || state.currentSessionId || null,
    expectedSessionId: prepared.sessionId,
    expectedMessageId: expected.messageId,
    messageCount: messages.length,
    foundById: Boolean(matchedById),
    foundByMarker: Boolean(matchedByMarker),
    bodyIncludesMarker: bodyText.includes(prepared.marker),
    matchedMessage: matched ? {
      id: matched.id,
      role: matched.role,
      contentPreview: extractText(matched).slice(0, 500),
    } : undefined,
    messageIds: messages.map((message) => message?.id).filter(Boolean),
    bodyTextTail: bodyText.slice(-2000),
  });
})()
`;
}

function reloadExpression(): string {
  return `
(() => {
  setTimeout(() => location.reload(), 500);
  return JSON.stringify({ reloading: true });
})()
`;
}

export async function runChatMessagePersistence(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const prepared = requireChatPreparation(context);

  const openResult = evalJson<{
    ok: boolean;
    sessionId?: string | null;
    selectedSpaceId?: string | null;
    visible?: boolean;
    messageCount?: number;
    bodyTextTail?: string;
  }>(context, openPreparedSessionExpression(prepared, null), { timeoutMs: 90000 });
  await context.writeJson("snapshots/chat-message-open-session-result.json", openResult);
  if (!openResult.ok || openResult.selectedSpaceId !== prepared.spaceId) {
    throw new Error(`Chat session open failed: ${JSON.stringify(openResult)}`);
  }

  const composerReady = await pollRenderer<{
    ready: boolean;
    hasTextarea: boolean;
    visible: boolean;
    disabled: boolean;
    bodyTextTail: string;
  }>(
    context,
    () => chatComposerReadyExpression(prepared, null),
    (value) => value.ready,
    { timeoutMs: 60000, intervalMs: 3000, label: "chat composer ready" },
  );
  const composerReadyPath = await context.writeJson(
    "snapshots/chat-message-composer-ready.json",
    composerReady,
  );

  const sendResult = submitMessageThroughComposer(context, prepared, null);
  const sendResultPath = await context.writeJson(
    "snapshots/chat-message-send-result.json",
    sendResult,
  );
  if (!sendResult.ok) {
    throw new Error(`Chat composer send failed: ${JSON.stringify(sendResult)}`);
  }

  const dbVerification = await verifyChatMessagePersisted(context, prepared);
  const actualSessionId = dbVerification.sessionId;
  const actualPrepared = { ...prepared, sessionId: actualSessionId };
  const dbVerificationPath = await context.writeJson(
    "snapshots/chat-message-db-verification.json",
    dbVerification,
  );

  let electronReportedSessionId: string | null = null;
  try {
    const actualSession = readElectronChatSession(context);
    electronReportedSessionId = actualSession.sessionId;
    await context.writeJson("snapshots/chat-message-electron-session-after-send.json", actualSession);
  } catch (error) {
    await context.writeText(
      "logs/chat-message-electron-session-after-send-error.log",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (electronReportedSessionId && electronReportedSessionId !== actualSessionId) {
    await context.writeText(
      "logs/chat-message-electron-session-after-send-mismatch.log",
      JSON.stringify({ electronReportedSessionId, actualSessionId }, null, 2),
    );
  }

  const storeAfterPersist = await pollRenderer<RendererMessageEvidence>(
    context,
    () => rendererMessageEvidenceExpression(actualPrepared, dbVerification),
    (value) =>
      value.currentSessionId === actualSessionId &&
      value.foundById &&
      value.foundByMarker,
    { timeoutMs: 60000, intervalMs: 5000, label: "chat renderer store after persist" },
  );
  const storeAfterPersistPath = await context.writeJson(
    "snapshots/chat-message-renderer-store-after-persist.json",
    storeAfterPersist,
  );
  const domAfterPersist = await pollRenderer<{
    visible: boolean;
    messageCount: string | null;
    virtualRowCount: string | null;
    isForeground: string | null;
    bodyTextTail: string;
  }>(
    context,
    () => markerDomEvidenceExpression(prepared.marker),
    (value) => value.visible,
    { timeoutMs: 60000, intervalMs: 3000, label: "chat message DOM after persist" },
  );
  const domAfterPersistPath = await context.writeJson(
    "snapshots/chat-message-dom-after-persist.json",
    domAfterPersist,
  );

  try {
    evalJson(context, reloadExpression(), { timeoutMs: 15000, awaitPromise: false });
  } catch (error) {
    await context.writeText(
      "logs/chat-message-reload-trigger-error.log",
      error instanceof Error ? error.message : String(error),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 12000));

  const reopenAfterReload = evalJson<{
    ok: boolean;
    sessionId?: string;
    visible?: boolean;
    messageCount?: number;
    bodyTextTail?: string;
  }>(context, openPreparedSessionExpression(prepared, actualSessionId), { timeoutMs: 90000 });
  const reopenAfterReloadPath = await context.writeJson(
    "snapshots/chat-message-reopen-session-after-reload.json",
    reopenAfterReload,
  );
  if (!reopenAfterReload.ok || reopenAfterReload.sessionId !== actualSessionId) {
    throw new Error(`Chat session reopen after reload failed: ${JSON.stringify(reopenAfterReload)}`);
  }

  const storeAfterReload = await pollRenderer<RendererMessageEvidence>(
    context,
    () => rendererMessageEvidenceExpression(actualPrepared, dbVerification),
    (value) =>
      value.currentSessionId === actualSessionId &&
      value.foundById &&
      value.foundByMarker,
    { timeoutMs: 60000, intervalMs: 5000, label: "chat renderer store after reload" },
  );
  const storeAfterReloadPath = await context.writeJson(
    "snapshots/chat-message-renderer-store-after-reload.json",
    storeAfterReload,
  );

  const domAfterReload = await pollRenderer<{
    visible: boolean;
    messageCount: string | null;
    virtualRowCount: string | null;
    isForeground: string | null;
    bodyTextTail: string;
  }>(
    context,
    () => markerDomEvidenceExpression(prepared.marker),
    (value) => value.visible,
    { timeoutMs: 60000, intervalMs: 5000, label: "chat message DOM after reload" },
  );
  const domAfterReloadPath = await context.writeJson(
    "snapshots/chat-message-dom-after-reload.json",
    domAfterReload,
  );

  return {
    id: "chat.send-and-restore-message",
    title: "验证用户消息经 composer 提交、落库并在刷新后恢复",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message: "User chat message was submitted through Electron composer, persisted in PostgreSQL, and remained visible after reopening the session post-reload.",
    artifacts: [
      composerReadyPath,
      sendResultPath,
      dbVerificationPath,
      storeAfterPersistPath,
      domAfterPersistPath,
      reopenAfterReloadPath,
      storeAfterReloadPath,
      domAfterReloadPath,
    ],
  };
}
