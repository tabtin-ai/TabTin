import type { RunContext } from "../runner/types";
import { runCommand } from "../runner/process";
import type { ElectronSelection } from "./electron-selection";

export type ElectronChatSession = {
  sessionId: string;
  spaceId: string | null;
  docCount: number;
};

export function readElectronChatSession(context: RunContext): ElectronChatSession {
  const expression = `
(async () => {
  const spaceId = JSON.parse(localStorage.getItem('tabtin-space-list') || '{}').state?.selectedSpaceId || null;
  try {
    const mod = await import('/src/stores/useChatStore.ts');
    const state = mod.useChatStore.getState();
    const currentSessionId =
      (spaceId && state.currentSessionIdBySpaceId?.[spaceId]) ||
      state.currentSessionId ||
      null;
    if (currentSessionId) {
      return JSON.stringify({
        sessionId: currentSessionId,
        spaceId,
        docCount: state.sessionsBySpaceId?.[spaceId]?.length ?? state.sessions?.length ?? 0,
        source: 'renderer-store'
      });
    }
  } catch {
    // Fall back to IndexedDB cache below.
  }
  const req = indexedDB.open('tabtin-chat-cache', 2);
  const db = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const docs = await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const request = tx.objectStore('sessions').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  if (!docs.length) {
    throw new Error('No chat session cache found in IndexedDB (tabtin-chat-cache). Open chat once before running this scenario.');
  }
  const sorted = [...docs].sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0));
  return JSON.stringify({
    sessionId: sorted[0].sessionId,
    spaceId,
    docCount: docs.length,
  });
})()
`;
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: 60000,
  });
  const session = JSON.parse(result.stdout.trim()) as Partial<ElectronChatSession>;
  if (!session.sessionId) {
    throw new Error(`Electron chat session is incomplete: ${JSON.stringify(session)}`);
  }
  return {
    sessionId: session.sessionId,
    spaceId: session.spaceId ?? null,
    docCount: session.docCount ?? 0,
  };
}

function createElectronChatSessionExpression(selection: ElectronSelection): string {
  return `
(async () => {
  const spaceId = ${JSON.stringify(selection.spaceId)};
  const organizationId = ${JSON.stringify(selection.organizationId)};
  const userId = ${JSON.stringify(selection.userId)};
  const [{ useChatStore }, { useMainNavStore }, { useSpaceViewPrefsStore }, { useUIStore }] = await Promise.all([
    import('/src/stores/useChatStore.ts'),
    import('/src/stores/useMainNavStore.ts'),
    import('/src/stores/useSpaceViewPrefsStore.ts'),
    import('/src/stores/useUIStore.ts'),
  ]);
  useMainNavStore.getState().setCurrentTab('agent');
  useSpaceViewPrefsStore.getState().setSidebarModeForOrganizationUser(organizationId, userId, 'conversations');
  useUIStore.getState().setChatSidePanelCollapsed(false);
  await useChatStore.getState().createSession(spaceId, organizationId);
  const state = useChatStore.getState();
  const currentSessionId =
    state.currentSessionIdBySpaceId?.[spaceId] ||
    state.currentSessionId ||
    state.sessionsBySpaceId?.[spaceId]?.[0]?.id ||
    state.sessions?.[0]?.id ||
    null;
  if (!currentSessionId) {
    throw new Error('createSession completed but no sessionId was selected');
  }
  return JSON.stringify({
    sessionId: currentSessionId,
    spaceId,
    docCount: state.sessionsBySpaceId?.[spaceId]?.length ?? state.sessions?.length ?? 0
  });
})()
`;
}

export function createElectronChatSession(
  context: RunContext,
  selection: ElectronSelection,
): ElectronChatSession {
  const result = runCommand("node", ["scripts/cdp-eval.mjs", createElectronChatSessionExpression(selection)], {
    cwd: context.repoRoot,
    timeoutMs: 90000,
  });
  const session = JSON.parse(result.stdout.trim()) as Partial<ElectronChatSession>;
  if (!session.sessionId) {
    throw new Error(`Electron chat session is incomplete after createSession: ${JSON.stringify(session)}`);
  }
  return {
    sessionId: session.sessionId,
    spaceId: session.spaceId ?? selection.spaceId,
    docCount: session.docCount ?? 0,
  };
}
