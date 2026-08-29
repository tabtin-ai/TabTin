/**
 * TabCode 主面板入口
 *
 * 布局由 WorkdirPaneShell 统一：结构性边线 + 侧栏背景差；
 * 控件沉在整面板通栏底栏（无顶栏），Git 标签内提交区置顶。
 * Monaco 预览区本身仍保持无边框画布感。
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@tabtin/smartsheet-ui';
import { useFolderWatch } from '@hooks/useFolderWatch';
import { useChatStore } from '@stores/chat/useChatStore';
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore';
import { useSpaceContextNavigation } from '@components/context-space/hooks/useSpaceContextNavigation';
import { resolveTabCodeSessionId } from '@components/layout/workspaceContextState';
import { normalizePathForCompare } from './utils/worktreePaths';
import { createLogger } from '@/utils/logger';
import { type GitFlowSwitchProps } from './components/TabCodeToolbar';
import { TabCodeStatusBar } from './components/TabCodeStatusBar';
import { TabCodeFileTree } from './components/TabCodeFileTree';
import { TabCodeRecentlyClosed } from './components/TabCodeEditorTabs';
import { TabCodeEditorGroupLayout } from './components/TabCodeEditorGroupLayout';
import type { DiffMode } from './components/TabCodeDiffView';
import { TabCodeEmptyState } from './components/TabCodeEmptyState';
import { TabCodePathMissing } from './components/TabCodePathMissing';
import { BranchOperationsDialog } from './components/git-workflow/BranchOperationsDialog';
import { GitWorkflowPanel } from './components/git-workflow/GitWorkflowPanel';
import { useWorktreeDialogStore } from './components/git-workflow/useWorktreeDialogStore';
import { formatGitErrorForToast } from './components/git-workflow/gitErrorMessage';
import {
  canPushBranch,
  resolvePushRemote,
} from './components/git-workflow/gitRemoteSync';
import { logGitActionFailure } from './utils/gitActionDiagnostics';
import {
  TabCodeSidebarStack,
  type TabCodeSidebarTab,
} from './components/TabCodeSidebarStack';
import { resolveExternalSidebarTabIntent } from './utils/resolveExternalSidebarTabIntent';
import { QuickOpenDialog } from './components/QuickOpenDialog';
import { KeywordSearchPanel } from './components/KeywordSearchPanel';
import type { KeywordSearchSelectTarget } from './components/KeywordSearchPanel';
import type { EditorFindRequest } from '@components/shared/file-preview/editorFindTypes';
import type { TextEditorState } from '@components/shared/file-preview/TextFileEditor';
import { editorStateKey } from './utils/editorStateKey';
import {
  getTabCodeWorkspaceSessionKey,
  getUnscopedTabCodeWorkspaceSessionKey,
  normalizeTabCodeRootKey,
  useTabCodeStore,
} from './hooks/useTabCodeStore';
import { useGitStatus } from './hooks/useGitStatus';
import { WorkdirPaneShell } from '@components/layout/WorkdirPaneShell';
import { HOTKEYS, useHotkey } from './utils/hotkeys';
import {
  resolveGitDiffModeForViewMode,
  resolveVisibleSelectedFileForViewMode,
} from './utils/viewModeSelection';
import { useFocusedSurfaceReporter } from '@stores/useFocusedSurfaceStore';
import type { ContextTabKey } from '@components/context-space/registry/types';
import {
  createEditorWorkspace,
  ROOT_EDITOR_GROUP_ID,
} from './utils/editorGroupLayout';
import { openCodeChangesTab } from '@components/context-space/code-workspace/codeWorkspaceTab';

interface TabCodePaneHostProps {
  rootPath: string | null;
  spaceId?: string | null;
  /** 当前 UI 标签组 scope；打开 tab 时优先使用，资源/业务归属仍用 spaceId。 */
  tabScopeKey?: string | null;
  contextTabKey?: ContextTabKey | null;
  resourceId?: string;
  /** 由 `LocalDirAutoPane` 托管时传入——目录内嵌「Git 流程模式」开关；其它入口（如 worktree 跳转）不传则不显示。 */
  gitFlowSwitch?: GitFlowSwitchProps;
  /**
   * 外层（如 LocalDirAutoPane）已确认是 Git 仓库时传入，避免首帧按非仓库渲染
   * 再等 fullStatus 插入 Git 标签造成布局跳变。
   */
  assumeGitRepo?: boolean;
  /**
   * 冷开 Tab 时的侧栏目标（如画布轨「提交或推送」写入 meta.initialSidebarTab）。
   * 用于首帧 useState，避免等 effect / isGitRepo 就绪前停在目录栏。
   */
  initialSidebarTab?: TabCodeSidebarTab;
  /** 当前 pane 是否前台；用于 keep-alive 重激活时重放侧栏意图。 */
  isPaneActive?: boolean;
}

const log = createLogger('TabCodePaneHost');

const EMPTY_HISTORY: string[] = [];
const EMPTY_EDITOR_WORKSPACE = createEditorWorkspace();
const EMPTY_PREVIEW_FILES: Record<string, string> = {};
const EMPTY_PREVIEW_ACTIVITY: Record<string, boolean> = {};
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 400;
const PATH_PROBE_CONCURRENCY = 8;

async function findMissingPaths(paths: string[]): Promise<string[]> {
  const missingPaths: string[] = [];
  for (let index = 0; index < paths.length; index += PATH_PROBE_CONCURRENCY) {
    const batch = paths.slice(index, index + PATH_PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          const result = await window.tabtin.fileSystem.pathExists(path);
          return result?.success === true && !result.exists ? path : null;
        } catch {
          return null;
        }
      }),
    );
    missingPaths.push(
      ...results.filter((path): path is string => Boolean(path)),
    );
  }
  return missingPaths;
}

export const TabCodePaneHost: React.FC<TabCodePaneHostProps> = ({
  rootPath,
  spaceId,
  tabScopeKey,
  contextTabKey,
  resourceId,
  gitFlowSwitch,
  assumeGitRepo = false,
  initialSidebarTab,
  isPaneActive = true,
}) => {
  const { t } = useTranslation('tabcode');
  // 画布轨「提交或推送」冷开 Tab：首帧即按 Git 仓库渲染侧栏，避免探测前把意图打回目录。
  const effectiveAssumeGitRepo =
    assumeGitRepo || initialSidebarTab === 'git';
  //  / ：Worktree 侧栏入口需要「打开为新标签」与「设为对话代码根」，
  // 分别需要 spaceId（打开标签/授权路径）与当前会话 id（绑定执行根）。
  const spaceSessionId = useChatStore(
    useCallback(
      (s) => (spaceId ? (s.currentSessionIdBySpaceId[spaceId] ?? null) : null),
      [spaceId],
    ),
  );
  const sessionId = resolveTabCodeSessionId(tabScopeKey, spaceSessionId);
  const { openCodeProject } = useSpaceContextNavigation({
    spaceId: spaceId ?? '',
    tabScopeKey: tabScopeKey ?? undefined,
  });
  const worktreeDialogOwnerId = useMemo(
    () =>
      `${tabScopeKey ?? spaceId ?? 'standalone'}:${contextTabKey ?? rootPath ?? 'unknown'}`,
    [contextTabKey, rootPath, spaceId, tabScopeKey],
  );
  const handleOpenWorktreeProjectPath = useCallback(
    (path: string) => {
      // 先让导航层同步激活或创建目标标签；随后关闭源 TabCode 标签。
      // 不改写 tabKey/meta.path，继续沿用 TabCode 以路径派生身份的约定。
      openCodeProject(path);

      const storageKey = tabScopeKey ?? spaceId;
      if (!storageKey || !contextTabKey?.startsWith('tabcode:')) return;

      const tabs = useSpaceContextTabsStore.getState();
      if (tabs.activeKeyBySpace[storageKey] === contextTabKey) {
        log.warn(
          'worktree switch did not activate the target tab; preserving source tab',
          {
            sourceTabKey: contextTabKey,
            targetPath: path,
          },
        );
        return;
      }
      tabs.closeTab(storageKey, contextTabKey);
    },
    [contextTabKey, openCodeProject, spaceId, tabScopeKey],
  );
  const [validatedSessionKey, setValidatedSessionKey] = useState<string | null>(
    null,
  );
  const [isBranchOperationsOpen, setIsBranchOperationsOpen] = useState(false);
  const [activeSidebarTab, setActiveSidebarTab] =
    useState<TabCodeSidebarTab>(() => initialSidebarTab ?? 'files');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const isSearchTabActive = activeSidebarTab === 'search';
  const [selectedLine, setSelectedLine] = useState<
    { line: number; ts: number } | undefined
  >(undefined);
  const [findRequest, setFindRequest] = useState<EditorFindRequest | undefined>(
    undefined,
  );
  const [selectedGitDiffMode, setSelectedGitDiffMode] = useState<
    DiffMode | undefined
  >(undefined);
  const [editorStatesByFile, setEditorStatesByFile] = useState<
    Map<string, TextEditorState>
  >(() => new Map());
  const queuedPathProbeSessionKeyRef = useRef<string | null>(null);
  const queuedPathProbePathsRef = useRef(new Set<string>());
  const isPathProbeRunningRef = useRef(false);

  // 项目根目录可达性探针 ——
  //
  // 项目目录可能在用户使用过程中消失（手动 mv / rm，外接盘 unmount，
  // 网络盘掉线）。一旦消失，底层 git / chunker / checkpoint 全部命令
  // 都会 fatal（git 会在 setup_git_directory 阶段就报"Invalid path"）。
  // 在这里做一次轻量 stat 探针：missing 时整面板降级到 TabCodePathMissing，
  // 不再触发任何依赖目录真实存在的 hook 请求（gitStatus / codeIndex /
  // checkpoint 等都跳过），避免错误冒到用户面前。
  //
  // 默认乐观（'unknown'）—— 99% 场景目录都在，闪 loading 反而难看；
  // 异步探测发现 missing 才切到降级 UI。
  const [pathStatus, setPathStatus] = useState<
    'unknown' | 'exists' | 'missing'
  >('unknown');
  useEffect(() => {
    let cancelled = false;
    if (!rootPath) {
      setPathStatus('unknown');
      return;
    }
    setPathStatus('unknown');
    const check = async () => {
      try {
        const fs = window.tabtin?.fileSystem;
        if (!fs?.pathExists) {
          // 兜底：preload 没暴露 pathExists（理论上不可能，开发时 stale
          // bundle 可能出现）—— 当作存在，让原有逻辑走，不阻塞用户。
          setPathStatus('exists');
          return;
        }
        const result = await fs.pathExists(rootPath);
        if (cancelled) return;
        if (!result?.success) {
          log.warn('pathExists probe was unsuccessful', {
            error: result?.error,
          });
          setPathStatus('exists');
          return;
        }
        const exists = !!result?.exists && (result.isDirectory ?? true);
        setPathStatus(exists ? 'exists' : 'missing');
      } catch (err) {
        if (cancelled) return;
        log.warn('pathExists probe failed', {
          errorType: err instanceof Error ? err.name : typeof err,
        });
        setPathStatus('exists');
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const previewHistory = useTabCodeStore(
    (s) => s.previewHistoryByRootPath[rootPath ?? ''] ?? EMPTY_HISTORY,
  );
  const pushPreviewHistory = useTabCodeStore((s) => s.pushPreviewHistory);
  const sessionKey = useMemo(
    () =>
      rootPath
        ? getTabCodeWorkspaceSessionKey(tabScopeKey, resourceId, rootPath)
        : null,
    [rootPath, tabScopeKey, resourceId],
  );
  const unscopedSessionKey = useMemo(
    () =>
      rootPath
        ? getUnscopedTabCodeWorkspaceSessionKey(
            tabScopeKey,
            resourceId,
            rootPath,
          )
        : null,
    [rootPath, tabScopeKey, resourceId],
  );

  useEffect(() => {
    setEditorStatesByFile(new Map());
    // editor dirty state belongs to this workspace session, never to rootPath alone.
  }, [sessionKey]);

  const handleEditorStateChange = useCallback(
    (
      stateSessionKey: string,
      groupId: string,
      filePath: string,
      state: TextEditorState | null,
    ) => {
      setEditorStatesByFile((current) => {
        const next = new Map(current);
        const key = editorStateKey(stateSessionKey, groupId, filePath);
        if (state) next.set(key, state);
        else next.delete(key);
        return next;
      });
    },
    [],
  );

  const workspaceSession = useTabCodeStore((s) =>
    sessionKey ? (s.workspaceSessionsByKey[sessionKey] ?? null) : null,
  );
  const editorWorkspace = workspaceSession ?? EMPTY_EDITOR_WORKSPACE;
  const previewFilesByGroup =
    workspaceSession?.previewFilesByGroup ?? EMPTY_PREVIEW_FILES;
  const previewActiveByGroup =
    workspaceSession?.previewActiveByGroup ?? EMPTY_PREVIEW_ACTIVITY;
  const activeFile =
    editorWorkspace.groupsById[editorWorkspace.activeGroupId]?.activeFile ??
    null;
  const previewFile =
    previewFilesByGroup[editorWorkspace.activeGroupId] ?? null;
  const isPreviewActive = Boolean(
    previewFile && previewActiveByGroup[editorWorkspace.activeGroupId],
  );
  const selectedFile = isPreviewActive ? previewFile : activeFile;
  const openFiles = useMemo(
    () =>
      Object.values(editorWorkspace.groupsById).flatMap(
        (group) => group.openFiles,
      ),
    [editorWorkspace.groupsById],
  );
  const recentlyClosedFiles =
    workspaceSession?.recentlyClosedFiles ?? EMPTY_HISTORY;
  const expandedDirs = useTabCodeStore((s) =>
    sessionKey
      ? (s.workspaceSessionsByKey[sessionKey]?.expandedDirs ?? EMPTY_HISTORY)
      : EMPTY_HISTORY,
  );
  const openFileInWorkspaceSession = useTabCodeStore(
    (s) => s.openFileInWorkspaceSession,
  );
  const activateWorkspaceFile = useTabCodeStore((s) => s.activateWorkspaceFile);
  const closeFileInWorkspaceSession = useTabCodeStore(
    (s) => s.closeFileInWorkspaceSession,
  );
  const pushRecentlyClosedFile = useTabCodeStore(
    (s) => s.pushRecentlyClosedFile,
  );
  const setActiveWorkspaceEditorGroup = useTabCodeStore(
    (s) => s.setActiveWorkspaceEditorGroup,
  );
  const moveWorkspaceFile = useTabCodeStore((s) => s.moveWorkspaceFile);
  const splitWorkspaceFile = useTabCodeStore((s) => s.splitWorkspaceFile);
  const pinWorkspaceEditorGroup = useTabCodeStore((s) => s.pinWorkspaceEditorGroup);
  const unpinWorkspaceEditorGroup = useTabCodeStore((s) => s.unpinWorkspaceEditorGroup);
  const splitEmptyWorkspaceGroup = useTabCodeStore((s) => s.splitEmptyWorkspaceGroup);
  const setWorkspaceSplitSizes = useTabCodeStore(
    (s) => s.setWorkspaceSplitSizes,
  );
  const reorderWorkspaceFile = useTabCodeStore((s) => s.reorderWorkspaceFile);
  const adoptUnscopedWorkspaceSession = useTabCodeStore(
    (s) => s.adoptUnscopedWorkspaceSession,
  );
  const setExpandedDirsForWorkspaceSession = useTabCodeStore(
    (s) => s.setExpandedDirsForWorkspaceSession,
  );
  const setWorkspacePreview = useTabCodeStore((s) => s.setWorkspacePreview);
  const pruneWorkspaceSessionPaths = useTabCodeStore(
    (s) => s.pruneWorkspaceSessionPaths,
  );
  const consumePendingReveal = useTabCodeStore((s) => s.consumePendingReveal);

  const schedulePathPrune = useCallback(
    (targetSessionKey: string, paths: string[]) => {
      if (queuedPathProbeSessionKeyRef.current !== targetSessionKey) {
        queuedPathProbeSessionKeyRef.current = targetSessionKey;
        queuedPathProbePathsRef.current.clear();
      }
      paths.forEach((path) => queuedPathProbePathsRef.current.add(path));
      if (isPathProbeRunningRef.current) return;

      isPathProbeRunningRef.current = true;
      const flush = async () => {
        while (queuedPathProbePathsRef.current.size > 0) {
          const scannedSessionKey = queuedPathProbeSessionKeyRef.current;
          const candidates = [...queuedPathProbePathsRef.current];
          queuedPathProbePathsRef.current.clear();
          const invalidPaths = await findMissingPaths(candidates);
          if (
            scannedSessionKey &&
            queuedPathProbeSessionKeyRef.current === scannedSessionKey &&
            invalidPaths.length > 0
          ) {
            pruneWorkspaceSessionPaths(scannedSessionKey, invalidPaths);
          }
        }
        isPathProbeRunningRef.current = false;
      };
      void flush();
    },
    [pruneWorkspaceSessionPaths],
  );

  useEffect(
    () => () => {
      queuedPathProbeSessionKeyRef.current = null;
      queuedPathProbePathsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (sessionKey && unscopedSessionKey) {
      adoptUnscopedWorkspaceSession(sessionKey, unscopedSessionKey);
    }
  }, [sessionKey, unscopedSessionKey, adoptUnscopedWorkspaceSession]);

  // 根被删时立即降级；普通 rename 事件则确认对应路径是否仍存在，及时删掉
  // 非活动标签、最近关闭文件与目录展开状态中的孤儿路径。global 事件没有具体
  // 路径，因此对该会话的所有已持久化路径做一次有限批量探测。
  useFolderWatch(
    pathStatus === 'exists' && rootPath ? rootPath : null,
    useCallback(
      (_rootId, events) => {
        if (events.some((event) => event.isRootLost)) {
          setPathStatus('missing');
          return;
        }
        if (!sessionKey) return;

        const session =
          useTabCodeStore.getState().workspaceSessionsByKey[sessionKey];
        const globalRescan = events.some((event) => event.isGlobal);
        const candidates = globalRescan
          ? [
              ...Object.values(session?.groupsById ?? {}).flatMap(
                (group) => group.openFiles,
              ),
              ...Object.values(session?.previewFilesByGroup ?? {}),
              ...(session?.expandedDirs ?? []),
              ...(session?.recentlyClosedFiles ?? []),
            ]
          : events
              .filter((event) => event.eventType === 'rename' && event.fullPath)
              .map((event) => event.fullPath as string);
        const uniqueCandidates = [...new Set(candidates)];
        if (uniqueCandidates.length === 0) return;

        schedulePathPrune(sessionKey, uniqueCandidates);
      },
      [sessionKey, schedulePathPrune],
    ),
  );
  // 与 setPendingReveal 同用 normalizeTabCodeRootKey，避免 working_dir 尾斜杠 /
  // 分隔符差异导致「写了 pending、Pane 永远读不到」。
  const revealRootKey = useMemo(
    () => (rootPath ? normalizeTabCodeRootKey(rootPath) : null),
    [rootPath],
  );
  // 订阅 pendingReveal 变化——保证用户**连续点击不同文件**时（tab 已存在，
  // 不会重新 mount），useEffect 依赖能感知新设的 pendingReveal 重新触发消费。
  const pendingRevealFile = useTabCodeStore((s) =>
    revealRootKey ? (s.pendingRevealByRootPath[revealRootKey] ?? null) : null,
  );

  // 只在会话/根目录切换时做恢复前校验。不能依赖 openFiles / expandedDirs：
  // 激活或排序标签会生成新的聚合数组，若因此把 validatedSessionKey 清空，会把
  // 整棵编辑器布局卸载再挂载，造成肉眼可见的白帧。运行期删除由 folder watch
  // 与单文件 watch 持续裁剪，不需要靠重新阻塞整个工作台兜底。
  useEffect(() => {
    let cancelled = false;
    setValidatedSessionKey(null);
    if (!sessionKey || !rootPath || pathStatus !== 'exists') return;

    const validate = async () => {
      const snapshot =
        useTabCodeStore.getState().workspaceSessionsByKey[sessionKey];
      const files = Object.values(snapshot?.groupsById ?? {}).flatMap(
        (group) => group.openFiles,
      );
      const previews = Object.values(snapshot?.previewFilesByGroup ?? {});
      const expandedDirectories = snapshot?.expandedDirs ?? [];
      const candidates = [
        ...files.map((path) => ({ path, kind: 'file' as const })),
        ...previews.map((path) => ({ path, kind: 'file' as const })),
        ...expandedDirectories.map((path) => ({
          path,
          kind: 'directory' as const,
        })),
      ];
      const results = await Promise.all(
        candidates.map(async ({ path, kind }) => {
          try {
            const result = await window.tabtin.fileSystem.pathExists(path);
            if (result?.success !== true) return null;
            const isExpectedType =
              kind === 'directory'
                ? result?.isDirectory === true
                : result?.isDirectory !== true;
            return result?.exists && isExpectedType ? null : path;
          } catch {
            // IPC 短暂失败不能等价为文件已删除；保留现场，等待后续文件系统事件复查。
            return null;
          }
        }),
      );
      if (cancelled) return;
      const invalidPaths = results.filter((path): path is string =>
        Boolean(path),
      );
      if (invalidPaths.length > 0) {
        pruneWorkspaceSessionPaths(sessionKey, invalidPaths);
      }
      setValidatedSessionKey(sessionKey);
    };

    void validate();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, rootPath, pathStatus, pruneWorkspaceSessionPaths]);

  // **Pending reveal 应用**（cursor 风格：点击文件卡片直达文件而非项目根目录）。
  //
  // 来源：`useFileOpenAction.openInTabCode` 先 setPendingReveal 再 openResourceTab。
  //
  // 先确认 pending 路径仍是文件，再写入会话。异步探针让 StrictMode 的假卸载
  // 可以取消第一轮写入，避免被删路径触发预览读文件错误。
  useEffect(() => {
    if (
      !revealRootKey ||
      pathStatus !== 'exists' ||
      !pendingRevealFile?.filePath
    )
      return;

    const pending = pendingRevealFile;
    if (!sessionKey) return;
    let cancelled = false;
    const isCurrentPendingReveal = () =>
      useTabCodeStore.getState().pendingRevealByRootPath[revealRootKey]
        ?.requestId === pending.requestId;
    const applyPendingReveal = async () => {
      try {
        const result = await window.tabtin.fileSystem.pathExists(
          pending.filePath,
        );
        if (cancelled || !isCurrentPendingReveal()) return;
        if (result?.success !== true) return;
        if (!result?.exists || result.isDirectory === true) {
          pruneWorkspaceSessionPaths(sessionKey, [pending.filePath]);
          consumePendingReveal(revealRootKey, pending.requestId);
          return;
        }
      } catch {
        if (cancelled || !isCurrentPendingReveal()) return;
        // preload/IPC 短暂不可用时保留请求；下次用户再次触发 reveal 可重试。
        return;
      }
      if (cancelled || !isCurrentPendingReveal()) return;

      // pending reveal 的路径校验是异步的；校验期间用户可能已切换编辑器组。
      // 冷启动时还没有 session，store 会惰性创建根分区承接首次打开。
      const targetGroupId =
        useTabCodeStore.getState().workspaceSessionsByKey[sessionKey]
          ?.activeGroupId ?? ROOT_EDITOR_GROUP_ID;
      openFileInWorkspaceSession(sessionKey, pending.filePath, targetGroupId);
      // 外部 reveal 固定并激活文件，但不能让已有预览继续霸占内容区。
      // 预览仍保留在标签栏，用户可随时切回。
      const previewPath =
        useTabCodeStore.getState().workspaceSessionsByKey[sessionKey]
          ?.previewFilesByGroup[targetGroupId] ?? null;
      setWorkspacePreview(sessionKey, targetGroupId, previewPath, false);
      // 若同时有「提交或推送」侧栏意图，不要把 Git 栏打回目录。
      const sidebarPending = rootPath
        ? (
            useTabCodeStore.getState().pendingSidebarTabByRootPath[
              normalizeTabCodeRootKey(rootPath)
            ]
            ?? useTabCodeStore.getState().pendingSidebarTabByRootPath[rootPath]
          )
        : null;
      if (sidebarPending?.tab !== 'git') {
        setActiveSidebarTab('files');
      }
      setSidebarCollapsed(false);
      setSelectedLine(
        pending.line && pending.line > 0
          ? { line: pending.line, ts: pending.requestId }
          : undefined,
      );
      setFindRequest(undefined);
      // DiffCard 点开：保留 gitDiffMode 以走 Monaco Diff；普通文件卡则清掉。
      setSelectedGitDiffMode(pending.gitDiffMode ?? undefined);
      const consumed = consumePendingReveal(revealRootKey, pending.requestId);
      if (rootPath && consumed?.filePath) {
        pushPreviewHistory(rootPath, consumed.filePath);
      }
    };
    void applyPendingReveal();
    return () => {
      cancelled = true;
    };
  }, [
    revealRootKey,
    sessionKey,
    rootPath,
    pathStatus,
    pendingRevealFile,
    consumePendingReveal,
    pruneWorkspaceSessionPaths,
    openFileInWorkspaceSession,
    pushPreviewHistory,
    setWorkspacePreview,
  ]);

  // 当 path 已确认 missing 时，不再启动 gitStatus / codeIndex 等
  // 依赖真实目录的 hook —— 把 rootPath 传 null 让它们走 idle 分支。
  const safeRootPath = pathStatus === 'missing' ? null : rootPath;

  const {
    gitStatus,
    stagedStatus,
    unstagedStatus,
    branch,
    branchMeta,
    diffStat,
    isGitRepo,
    isLoading: isGitStatusLoading,
    statusRevision,
    contentRevisions,
    refresh: refreshGit,
  } = useGitStatus(safeRootPath, { assumeRepo: effectiveAssumeGitRepo });

  // （可选）：底栏标识当前浏览的是否为 linked worktree。只在确认是
  // Git 仓库后探测一次；`git worktree list` 恒定把主工作树排第一位，足够判定，
  // 不需要为此单独维护完整 worktree 列表状态。
  const [isLinkedWorktree, setIsLinkedWorktree] = useState(false);
  const [statusBarSyncActionKey, setStatusBarSyncActionKey] = useState<
    string | null
  >(null);
  const statusBarSyncActionKeyRef = useRef<string | null>(null);
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false);
  const [gitHistoryActive, setGitHistoryActive] = useState(false);
  const [gitHistoryGroupId, setGitHistoryGroupId] = useState<string | null>(null);
  const gitHistoryPinRef = useRef<{ sessionKey: string; groupId: string } | null>(null);

  const retargetGitHistoryPin = useCallback((nextGroupId: string | null) => {
    const previous = gitHistoryPinRef.current;
    if (
      previous
      && (previous.groupId !== nextGroupId || previous.sessionKey !== sessionKey)
    ) {
      unpinWorkspaceEditorGroup(previous.sessionKey, previous.groupId);
    }
    if (sessionKey && nextGroupId) {
      pinWorkspaceEditorGroup(sessionKey, nextGroupId);
      gitHistoryPinRef.current = { sessionKey, groupId: nextGroupId };
      return;
    }
    gitHistoryPinRef.current = null;
  }, [pinWorkspaceEditorGroup, sessionKey, unpinWorkspaceEditorGroup]);

  useEffect(() => {
    const previous = gitHistoryPinRef.current;
    if (previous) {
      unpinWorkspaceEditorGroup(previous.sessionKey, previous.groupId);
      gitHistoryPinRef.current = null;
    }
    setGitHistoryOpen(false);
    setGitHistoryActive(false);
    setGitHistoryGroupId(null);
  }, [sessionKey, rootPath, unpinWorkspaceEditorGroup]);
  useEffect(() => {
    if (!isGitRepo || !rootPath) {
      setIsLinkedWorktree(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.tabtin?.git?.listWorktrees?.(rootPath);
        if (cancelled || !result?.success) return;
        const mainPath = result.worktrees?.[0]?.path;
        setIsLinkedWorktree(
          Boolean(mainPath) &&
            normalizePathForCompare(rootPath) !==
              normalizePathForCompare(mainPath!),
        );
      } catch (err) {
        if (cancelled) return;
        log.warn('listWorktrees probe for toolbar indicator failed', {
          errorType: err instanceof Error ? err.name : typeof err,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isGitRepo, rootPath]);

  const runStatusBarGitAction = useCallback(
    async (
      key: string,
      action: () => Promise<{ success: boolean; error?: string } | null | undefined>,
      successDesc: string,
    ) => {
      if (!rootPath || statusBarSyncActionKeyRef.current) return;
      statusBarSyncActionKeyRef.current = key;
      setStatusBarSyncActionKey(key);
      try {
        const result = await action();
        if (result?.success) {
          let refreshFailed = false;
          try {
            await refreshGit();
          } catch (refreshError) {
            refreshFailed = true;
            logGitActionFailure(
              `statusbar:${key}:refresh`,
              rootPath,
              [],
              refreshError,
            );
          }
          toast({
            title: t('gitFlow.successTitle'),
            description: refreshFailed
              ? t('gitFlow.actionSucceededRefreshFailed', {
                  action: successDesc,
                })
              : successDesc,
          });
          return;
        }
        logGitActionFailure(`statusbar:${key}`, rootPath, [], result?.error);
        toast({
          title: t('gitFlow.errorTitle'),
          description: formatGitErrorForToast(result, t),
        });
      } catch (error) {
        logGitActionFailure(`statusbar:${key}`, rootPath, [], error);
        toast({
          title: t('gitFlow.errorTitle'),
          description: formatGitErrorForToast(error, t),
        });
      } finally {
        statusBarSyncActionKeyRef.current = null;
        setStatusBarSyncActionKey(null);
      }
    },
    [refreshGit, rootPath, t],
  );

  const handleStatusBarFetch = useCallback(() => {
    if (!rootPath) return;
    void runStatusBarGitAction(
      'fetch',
      () => window.tabtin.git.fetch(rootPath),
      t('gitFlow.fetchSuccess'),
    );
  }, [rootPath, runStatusBarGitAction, t]);

  const handleStatusBarPull = useCallback(() => {
    if (!rootPath) return;
    const remote = resolvePushRemote(branchMeta?.upstream);
    void runStatusBarGitAction(
      'pull',
      () => window.tabtin.git.pull(rootPath, { remote }),
      t('gitFlow.pullSuccess'),
    );
  }, [branchMeta?.upstream, rootPath, runStatusBarGitAction, t]);

  const handleStatusBarPush = useCallback(() => {
    if (!rootPath || !branchMeta || !canPushBranch(branchMeta)) return;
    const upstream = branchMeta.upstream || '';
    const remote = resolvePushRemote(upstream);
    void runStatusBarGitAction(
      'push',
      () =>
        window.tabtin.git.push(rootPath, {
          remote,
          branch: branch || undefined,
          setUpstream: !upstream,
          allowDirty: true,
        }),
      t('gitFlow.pushSuccess'),
    );
  }, [branch, branchMeta, rootPath, runStatusBarGitAction, t]);

  const visibleSelectedFile = useMemo(
    () =>
      resolveVisibleSelectedFileForViewMode({
        selectedFile,
        viewMode: 'all',
        stagedStatus,
        unstagedStatus,
      }),
    [selectedFile, stagedStatus, unstagedStatus],
  );
  const gitDiffMode = useMemo(
    () =>
      resolveGitDiffModeForViewMode({
        selectedFile: visibleSelectedFile,
        viewMode: 'all',
        stagedStatus,
        unstagedStatus,
      }),
    [visibleSelectedFile, stagedStatus, unstagedStatus],
  );
  // selectedGitDiffMode 来自 DiffCard pending reveal，必须在 viewMode=all 时也生效；
  // 以前 `all → undefined` 会把 chat 点开的 head Diff 直接掐掉，预览永远走普通编辑器。
  const previewGitDiffMode = selectedGitDiffMode ?? gitDiffMode;

  useFocusedSurfaceReporter({
    scopeKey: tabScopeKey,
    tabKey: contextTabKey,
    appType: 'tabcode',
    rootPath: pathStatus === 'missing' ? null : rootPath,
    focusedFilePath:
      validatedSessionKey === sessionKey ? visibleSelectedFile : null,
  });

  // Sync git context to store so ChatPanel can read it for context sync
  useEffect(() => {
    if (!rootPath) return;
    const changedFiles = Array.from(gitStatus.keys()).map((absPath) =>
      absPath.startsWith(rootPath)
        ? absPath.slice(rootPath.length).replace(/^\//, '')
        : absPath,
    );
    useTabCodeStore.getState().setGitContext(rootPath, {
      branch,
      changedFiles,
      selectedFile: visibleSelectedFile,
    });
  }, [rootPath, branch, gitStatus, visibleSelectedFile]);

  // ── 快捷键 ──
  const hasRoot = Boolean(rootPath);
  useHotkey(HOTKEYS.quickOpen, () => setIsQuickOpenOpen((v) => !v), hasRoot);

  useEffect(() => {
    if (!hasRoot) return;
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;
    const handler = (): void => {
      setIsQuickOpenOpen((v) => !v);
    };
    const unsub = ipc.on('shortcut:quick-open', handler);
    return () => {
      unsub?.();
    };
  }, [hasRoot]);
  useHotkey(HOTKEYS.recentFiles, () => setIsQuickOpenOpen((v) => !v), hasRoot);

  const selectPreviewFile = useCallback(
    (filePath: string, diffMode?: DiffMode) => {
      const groupId = editorWorkspace.activeGroupId;
      const group = editorWorkspace.groupsById[groupId];
      // 已固定的文件不能再占用预览槽：直接激活它并释放当前预览，避免内容区
      // 显示 previewFile 而标签激活态仍指向旧的固定文件。
      if (sessionKey && group?.openFiles.includes(filePath)) {
        activateWorkspaceFile(sessionKey, groupId, filePath);
        setWorkspacePreview(
          sessionKey,
          groupId,
          previewFilesByGroup[groupId] ?? null,
          false,
        );
      } else {
        const previousPreview = previewFilesByGroup[groupId];
        if (sessionKey && previousPreview && previousPreview !== filePath) {
          // 预览被替换视同关闭旧预览，进入「最近关闭」便于空态恢复。
          pushRecentlyClosedFile(sessionKey, previousPreview);
        }
        if (sessionKey)
          setWorkspacePreview(sessionKey, groupId, filePath, true);
      }
      if (rootPath) pushPreviewHistory(rootPath, filePath);
      setSelectedLine(undefined);
      setFindRequest(undefined);
      setSelectedGitDiffMode(diffMode);
    },
    [
      sessionKey,
      rootPath,
      editorWorkspace.activeGroupId,
      editorWorkspace.groupsById,
      previewFilesByGroup,
      activateWorkspaceFile,
      pushPreviewHistory,
      pushRecentlyClosedFile,
      setWorkspacePreview,
    ],
  );

  const handleClearPreview = useCallback(
    (groupId: string) => {
      const previewPath = previewFilesByGroup[groupId];
      if (sessionKey && previewPath) {
        pushRecentlyClosedFile(sessionKey, previewPath);
        setWorkspacePreview(sessionKey, groupId, null, false);
      }
    },
    [
      sessionKey,
      previewFilesByGroup,
      pushRecentlyClosedFile,
      setWorkspacePreview,
    ],
  );

  const handleFileSelect = useCallback(
    (filePath: string) => selectPreviewFile(filePath),
    [selectPreviewFile],
  );

  const handleGitChangeFileSelect = useCallback(
    (filePath: string, diffMode?: DiffMode) =>
      selectPreviewFile(filePath, diffMode),
    [selectPreviewFile],
  );

  const handleFileDoubleClick = useCallback(
    (filePath: string) => {
      if (!sessionKey || !rootPath) return;
      const groupId = editorWorkspace.activeGroupId;
      const group = editorWorkspace.groupsById[groupId];
      if (group?.openFiles.includes(filePath)) {
        activateWorkspaceFile(sessionKey, groupId, filePath);
        setWorkspacePreview(
          sessionKey,
          groupId,
          previewFilesByGroup[groupId] ?? null,
          false,
        );
        setSelectedLine(undefined);
        setFindRequest(undefined);
        setSelectedGitDiffMode(undefined);
        return;
      }
      openFileInWorkspaceSession(sessionKey, filePath, groupId);
      pushPreviewHistory(rootPath, filePath);
      setWorkspacePreview(sessionKey, groupId, null, false);
      setSelectedLine(undefined);
      setFindRequest(undefined);
      setSelectedGitDiffMode(undefined);
    },
    [
      sessionKey,
      rootPath,
      editorWorkspace.activeGroupId,
      editorWorkspace.groupsById,
      activateWorkspaceFile,
      openFileInWorkspaceSession,
      pushPreviewHistory,
      previewFilesByGroup,
      setWorkspacePreview,
    ],
  );

  const handleOpenGitHistory = useCallback(() => {
    if (gitHistoryOpen && gitHistoryGroupId) {
      setGitHistoryActive(true);
      if (sessionKey) setActiveWorkspaceEditorGroup(sessionKey, gitHistoryGroupId);
      return;
    }
    const groupId = editorWorkspace.activeGroupId || ROOT_EDITOR_GROUP_ID;
    retargetGitHistoryPin(groupId);
    setGitHistoryOpen(true);
    setGitHistoryActive(true);
    setGitHistoryGroupId(groupId);
  }, [
    editorWorkspace.activeGroupId,
    gitHistoryGroupId,
    gitHistoryOpen,
    retargetGitHistoryPin,
    sessionKey,
    setActiveWorkspaceEditorGroup,
  ]);

  const handleActivateGitHistory = useCallback(() => {
    setGitHistoryOpen(true);
    setGitHistoryActive(true);
    if (sessionKey && gitHistoryGroupId) {
      setActiveWorkspaceEditorGroup(sessionKey, gitHistoryGroupId);
    }
  }, [gitHistoryGroupId, sessionKey, setActiveWorkspaceEditorGroup]);

  const handleCloseGitHistory = useCallback(() => {
    retargetGitHistoryPin(null);
    setGitHistoryOpen(false);
    setGitHistoryActive(false);
    setGitHistoryGroupId(null);
  }, [retargetGitHistoryPin]);

  const handleMoveGitHistory = useCallback((_sourceGroupId: string, targetGroupId: string) => {
    if (!sessionKey || !targetGroupId) return;
    retargetGitHistoryPin(targetGroupId);
    setGitHistoryOpen(true);
    setGitHistoryActive(true);
    setGitHistoryGroupId(targetGroupId);
    setActiveWorkspaceEditorGroup(sessionKey, targetGroupId);
  }, [
    retargetGitHistoryPin,
    sessionKey,
    setActiveWorkspaceEditorGroup,
  ]);

  const handleSplitGitHistory = useCallback((
    _sourceGroupId: string,
    targetGroupId: string,
    side: 'left' | 'right' | 'top' | 'bottom',
  ) => {
    if (!sessionKey) return;
    const createdId = splitEmptyWorkspaceGroup(sessionKey, targetGroupId, side);
    if (!createdId) return;
    retargetGitHistoryPin(createdId);
    setGitHistoryOpen(true);
    setGitHistoryActive(true);
    setGitHistoryGroupId(createdId);
  }, [retargetGitHistoryPin, sessionKey, splitEmptyWorkspaceGroup]);

  const handleActivateFile = useCallback(
    (groupId: string, filePath: string) => {
      if (!sessionKey) return;
      setGitHistoryActive(false);
      activateWorkspaceFile(sessionKey, groupId, filePath);
      setWorkspacePreview(
        sessionKey,
        groupId,
        previewFilesByGroup[groupId] ?? null,
        false,
      );
      setSelectedLine(undefined);
      setFindRequest(undefined);
      setSelectedGitDiffMode(undefined);
    },
    [
      sessionKey,
      activateWorkspaceFile,
      previewFilesByGroup,
      setWorkspacePreview,
    ],
  );

  const handleActivatePreview = useCallback(
    (groupId: string) => {
      const previewPath = previewFilesByGroup[groupId];
      if (!sessionKey || !previewPath) return;
      setGitHistoryActive(false);
      setWorkspacePreview(sessionKey, groupId, previewPath, true);
      setSelectedLine(undefined);
      setFindRequest(undefined);
      setSelectedGitDiffMode(undefined);
    },
    [sessionKey, previewFilesByGroup, setWorkspacePreview],
  );

  const handlePinPreview = useCallback(
    (groupId: string, filePath: string) => {
      if (!sessionKey || !rootPath || previewFilesByGroup[groupId] !== filePath)
        return;
      openFileInWorkspaceSession(sessionKey, filePath, groupId);
      pushPreviewHistory(rootPath, filePath);
      setWorkspacePreview(sessionKey, groupId, null, false);
    },
    [
      sessionKey,
      rootPath,
      previewFilesByGroup,
      openFileInWorkspaceSession,
      pushPreviewHistory,
      setWorkspacePreview,
    ],
  );

  const pinSourcePreviewBeforeRemovingLastFile = useCallback(
    (sourceGroupId: string, removedFilePath: string) => {
      if (!sessionKey) return;
      const sourceGroup = editorWorkspace.groupsById[sourceGroupId];
      const sourcePreview = previewFilesByGroup[sourceGroupId];
      if (
        !sourcePreview ||
        sourcePreview === removedFilePath ||
        sourceGroup?.openFiles.length !== 1 ||
        sourceGroup.openFiles[0] !== removedFilePath
      ) {
        return;
      }
      // 分区布局不能承载仅有预览的空编辑器组；固定预览以保住
      // 源分区和用户当前可见文件，随后再移走原本被拖拽的固定标签。
      openFileInWorkspaceSession(sessionKey, sourcePreview, sourceGroupId);
      setWorkspacePreview(sessionKey, sourceGroupId, null, false);
    },
    [
      sessionKey,
      editorWorkspace.groupsById,
      previewFilesByGroup,
      openFileInWorkspaceSession,
      setWorkspacePreview,
    ],
  );

  const ensureEditorStateSaved = useCallback(
    async (groupId: string, filePath: string) => {
      if (!sessionKey) return false;
      const state = editorStatesByFile.get(
        editorStateKey(sessionKey, groupId, filePath),
      );
      if (!state?.dirty) return true;
      if (
        !window.confirm(
          t('editorTabs.dirtyMoveCloseConfirm', { file: filePath }),
        )
      ) {
        return false;
      }
      try {
        const saved = await state.save();
        if (saved) return true;
      } catch {
        // The alert below is intentionally generic; editor content is not logged.
      }
      window.alert(t('editorTabs.dirtyMoveCloseSaveFailed', { file: filePath }));
      return false;
    },
    [editorStatesByFile, sessionKey, t],
  );

  const handleCloseFile = useCallback(
    async (groupId: string, filePath: string) => {
      if (!sessionKey) return;
      if (!(await ensureEditorStateSaved(groupId, filePath))) return;
      const group = editorWorkspace.groupsById[groupId];
      const previewFile = previewFilesByGroup[groupId];
      // 工作区布局只持久化固定标签。若关掉最后一个固定标签前不先提升预览，
      // normalizeEditorWorkspace 会折叠该分区，导致预览既不可见又无激活项。
      if (
        previewFile &&
        group?.openFiles.length === 1 &&
        group.openFiles[0] === filePath
      ) {
        openFileInWorkspaceSession(sessionKey, previewFile, groupId);
        setWorkspacePreview(sessionKey, groupId, null, false);
      }
      closeFileInWorkspaceSession(sessionKey, groupId, filePath);
      if (previewFile === filePath)
        setWorkspacePreview(sessionKey, groupId, null, false);
      setSelectedLine(undefined);
      setFindRequest(undefined);
      setSelectedGitDiffMode(undefined);
    },
    [
      sessionKey,
      editorWorkspace.groupsById,
      previewFilesByGroup,
      openFileInWorkspaceSession,
      closeFileInWorkspaceSession,
      setWorkspacePreview,
      ensureEditorStateSaved,
    ],
  );

  const handleActivateGroup = useCallback(
    (groupId: string) => {
      if (!sessionKey) return;
      setActiveWorkspaceEditorGroup(sessionKey, groupId);
    },
    [sessionKey, setActiveWorkspaceEditorGroup],
  );

  const handleMoveFile = useCallback(
    async (
      sourceGroupId: string,
      targetGroupId: string,
      filePath: string,
      targetFilePath?: string | null,
      position?: 'before' | 'after',
    ) => {
      if (!sessionKey) return;
      if (!(await ensureEditorStateSaved(sourceGroupId, filePath))) return;
      if (sourceGroupId !== targetGroupId) {
        pinSourcePreviewBeforeRemovingLastFile(sourceGroupId, filePath);
      }
      moveWorkspaceFile(
        sessionKey,
        sourceGroupId,
        targetGroupId,
        filePath,
        targetFilePath,
        position,
      );
      // 拖入的固定标签成为当前内容；目标分区原有预览只转为非激活，不丢失。
      setWorkspacePreview(
        sessionKey,
        targetGroupId,
        previewFilesByGroup[targetGroupId] ?? null,
        false,
      );
    },
    [
      sessionKey,
      moveWorkspaceFile,
      pinSourcePreviewBeforeRemovingLastFile,
      previewFilesByGroup,
      setWorkspacePreview,
      ensureEditorStateSaved,
    ],
  );

  const handleReorderFile = useCallback(
    (
      groupId: string,
      sourceFilePath: string,
      targetFilePath: string,
      position: 'before' | 'after',
    ) => {
      if (!sessionKey) return;
      reorderWorkspaceFile(
        sessionKey,
        groupId,
        sourceFilePath,
        targetFilePath,
        position,
      );
    },
    [sessionKey, reorderWorkspaceFile],
  );

  const handleSplitFile = useCallback(
    async (
      sourceGroupId: string,
      targetGroupId: string,
      filePath: string,
      side: 'left' | 'right' | 'top' | 'bottom',
    ) => {
      if (!sessionKey) return;
      if (!(await ensureEditorStateSaved(sourceGroupId, filePath))) return;
      if (sourceGroupId !== targetGroupId) {
        pinSourcePreviewBeforeRemovingLastFile(sourceGroupId, filePath);
      }
      splitWorkspaceFile(
        sessionKey,
        sourceGroupId,
        targetGroupId,
        filePath,
        side,
      );
    },
    [
      ensureEditorStateSaved,
      sessionKey,
      splitWorkspaceFile,
      pinSourcePreviewBeforeRemovingLastFile,
    ],
  );

  const handleSplitResize = useCallback(
    (path: number[], sizes: number[]) => {
      if (!sessionKey) return;
      setWorkspaceSplitSizes(sessionKey, path, sizes);
    },
    [sessionKey, setWorkspaceSplitSizes],
  );

  const handleReopenFile = useCallback(
    async (filePath: string) => {
      if (!sessionKey || !rootPath || !filePath) return;
      try {
        const result = await window.tabtin.fileSystem.pathExists(filePath);
        if (result?.success !== true) return;
        if (!result.exists || result.isDirectory === true) {
          pruneWorkspaceSessionPaths(sessionKey, [filePath]);
          return;
        }
      } catch {
        return;
      }
      handleFileDoubleClick(filePath);
    },
    [sessionKey, rootPath, pruneWorkspaceSessionPaths, handleFileDoubleClick],
  );

  useHotkey(
    HOTKEYS.reopenClosed,
    () => {
      const latest = recentlyClosedFiles[0];
      if (latest) void handleReopenFile(latest);
    },
    hasRoot && recentlyClosedFiles.length > 0,
  );

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const setWorktreeDialogOpen = useWorktreeDialogStore((state) => state.setOpen);
  const handleOpenWorktree = useCallback(() => {
    setWorktreeDialogOpen(worktreeDialogOwnerId, true);
  }, [setWorktreeDialogOpen, worktreeDialogOwnerId]);

  const handleOpenChanges = useCallback(() => {
    if (!rootPath || !tabScopeKey) return;
    openCodeChangesTab({
      tabScopeKey,
      spaceId,
      rootPath,
      sessionId,
      initialView: 'uncommitted',
      focusView: 'uncommitted',
    });
  }, [rootPath, sessionId, spaceId, tabScopeKey]);

  const handleSwitchToFileBrowser = useCallback(() => {
    gitFlowSwitch?.onChange(false);
  }, [gitFlowSwitch]);

  const handleSidebarTabChange = useCallback(
    (tab: TabCodeSidebarTab) => {
      if (tab === 'git' && !isGitRepo) {
        setActiveSidebarTab('files');
        setSelectedGitDiffMode(undefined);
        return;
      }
      setActiveSidebarTab(tab);
      // 离开 Git 侧栏时清 Diff 意图，避免目录/搜索下仍停在「此文件无变更」
      if (tab !== 'git') {
        setSelectedGitDiffMode(undefined);
      }
    },
    [isGitRepo],
  );

  const handleCloseSearch = useCallback(() => {
    handleSidebarTabChange('files');
  }, [handleSidebarTabChange]);

  // 热键与侧栏点击共用清理逻辑；toggle 目标是 files↔search，不会进 git
  useHotkey(
    HOTKEYS.keywordSearch,
    () => {
      setSidebarCollapsed(false);
      handleSidebarTabChange(
        activeSidebarTab === 'search' ? 'files' : 'search',
      );
    },
    hasRoot,
  );

  const handleKeywordSearchFileSelect = useCallback(
    (filePath: string, target?: KeywordSearchSelectTarget) => {
      handleFileSelect(filePath);
      const ts = Date.now();
      if (target?.line && target.line > 0) {
        setSelectedLine({ line: target.line, ts });
      }
      const query = target?.matchText?.trim();
      if (
        query &&
        target?.line &&
        target.line > 0 &&
        target.matchKind !== 'path'
      ) {
        setFindRequest({
          query,
          key: ts,
          caseSensitive: target.findOptions?.caseSensitive,
          isRegex: target.findOptions?.isRegex,
          wholeWord: target.findOptions?.wholeWord,
          preferOccurrence: {
            line: target.line,
            // rg/renderer ranges 使用 0-based 字符偏移，Monaco occurrence 使用 1-based 列。
            column:
              target.column != null && target.column >= 0
                ? target.column + 1
                : undefined,
          },
        });
      }
    },
    [handleFileSelect],
  );

  // 画布轨「提交或推送」等外部意图：优先 pending（含 requestId），meta 兜底一次。
  const pendingSidebarPayload = useTabCodeStore((s) =>
    rootPath
      ? (s.pendingSidebarTabByRootPath[normalizeTabCodeRootKey(rootPath)]
        ?? s.pendingSidebarTabByRootPath[rootPath]
        ?? null)
      : null,
  );
  const consumedMetaSidebarTabRef = useRef<string | null>(null);
  const lastAppliedSidebarRequestIdRef = useRef(0);
  const metaConsumeKey = `${tabScopeKey ?? ''}:${contextTabKey ?? ''}:${rootPath ?? ''}`;
  const metaSidebarTab = useSpaceContextTabsStore((s) => {
    if (!tabScopeKey || !contextTabKey) return undefined;
    return s.itemsBySpace[tabScopeKey]?.[contextTabKey]?.meta?.initialSidebarTab;
  });

  // 仅在确认非仓库后回落；绝不在这里 consume pending（避免探测空窗期把意图吃掉）。
  useEffect(() => {
    if (isGitRepo || effectiveAssumeGitRepo || activeSidebarTab !== 'git') return;
    if (isGitStatusLoading || statusRevision === 0) return;
    if (pendingSidebarPayload?.tab === 'git') return;
    setActiveSidebarTab('files');
    setSelectedGitDiffMode(undefined);
  }, [
    isGitRepo,
    effectiveAssumeGitRepo,
    activeSidebarTab,
    isGitStatusLoading,
    statusRevision,
    pendingSidebarPayload,
  ]);

  useLayoutEffect(() => {
    if (!rootPath || !isPaneActive) return;
    const intent = resolveExternalSidebarTabIntent({
      pending: pendingSidebarPayload?.tab,
      meta: metaSidebarTab ?? initialSidebarTab,
      metaAlreadyConsumed: consumedMetaSidebarTabRef.current === metaConsumeKey,
      isGitRepo,
      assumeGitRepo: effectiveAssumeGitRepo,
    });
    if (!intent || intent.defer) return;

    if (intent.source === 'pending') {
      const requestId = pendingSidebarPayload?.requestId;
      if (
        requestId != null
        && requestId === lastAppliedSidebarRequestIdRef.current
      ) {
        return;
      }
      const consumed = useTabCodeStore
        .getState()
        .consumePendingSidebarTab(rootPath, requestId);
      if (!consumed) return;
      lastAppliedSidebarRequestIdRef.current = consumed.requestId;
    } else {
      consumedMetaSidebarTabRef.current = metaConsumeKey;
    }

    setActiveSidebarTab(intent.tab);
    setSidebarCollapsed(false);
    if (intent.tab !== 'git') setSelectedGitDiffMode(undefined);
    log.debug('applied external sidebar tab intent', {
      tab: intent.tab,
      source: intent.source,
      rootPath,
      requestId: pendingSidebarPayload?.requestId,
    });
  }, [
    rootPath,
    isPaneActive,
    pendingSidebarPayload,
    metaSidebarTab,
    initialSidebarTab,
    metaConsumeKey,
    isGitRepo,
    effectiveAssumeGitRepo,
  ]);

  if (!rootPath) {
    return <TabCodeEmptyState />;
  }

  // 项目目录已不存在 —— 整面板降级，避免下游 git / chunker / checkpoint
  // 报底层 fatal 把用户吓到。引导用户去 Agent 设置改 working_dir，
  // 同时提供「清理孤儿 shadow git」释放磁盘。
  if (pathStatus === 'missing') {
    return <TabCodePathMissing rootPath={rootPath} />;
  }

  return (
    <>
      <WorkdirPaneShell
        layoutId={`tabcode-${(resourceId ?? rootPath).replace(/[^a-zA-Z0-9_-]/g, '-')}`}
        surface="tabcode"
        sidebarMinWidth={SIDEBAR_MIN_WIDTH}
        sidebarMaxWidth={SIDEBAR_MAX_WIDTH}
        sidebarDefaultWidth={260}
        sidebarCollapsed={sidebarCollapsed}
        // 左侧目录 / Git / 搜索标签页；切换时不卸载面板，保留监听与内部状态。
        sidebar={
          <TabCodeSidebarStack
            activeTab={activeSidebarTab}
            onActiveTabChange={handleSidebarTabChange}
            fileTree={
              <TabCodeFileTree
                rootPath={rootPath}
                selectedFile={visibleSelectedFile}
                onOpenQuickOpen={() => setIsQuickOpenOpen(true)}
                initialExpandedDirs={expandedDirs}
                onExpandedDirsChange={(paths) => {
                  if (sessionKey)
                    setExpandedDirsForWorkspaceSession(sessionKey, paths);
                }}
                onFileSelect={handleFileSelect}
                onGitChangeFileSelect={handleGitChangeFileSelect}
                onFileDoubleClick={handleFileDoubleClick}
                gitStatus={gitStatus}
                stagedStatus={stagedStatus}
                unstagedStatus={unstagedStatus}
                viewMode="all"
                isGitRepo={isGitRepo}
                onGitActionComplete={refreshGit}
                onFileSystemChange={refreshGit}
              />
            }
            gitPanel={
              isGitRepo ? (
                <GitWorkflowPanel
                  rootPath={rootPath}
                  currentBranch={branch}
                  stagedCount={stagedStatus.size}
                  unstagedCount={unstagedStatus.size}
                  // 非激活标签仍挂载面板（见 TabCodeSidebarStack），保持 enabled
                  // 以便 statusRevision 持续刷新 Changes，切回即最新。
                  enabled
                  refreshToken={statusRevision}
                  spaceId={spaceId}
                  sessionId={sessionId}
                  tabScopeKey={tabScopeKey}
                  onRefreshGit={refreshGit}
                  onSelectChangeFile={handleGitChangeFileSelect}
                  onOpenProjectPath={
                    spaceId ? handleOpenWorktreeProjectPath : undefined
                  }
                  worktreeDialogOwnerId={worktreeDialogOwnerId}
                />
              ) : undefined
            }
            searchPanel={
              <KeywordSearchPanel
                rootPath={rootPath}
                editorSessionKey={sessionKey ?? ''}
                editorStatesByFile={editorStatesByFile}
                onFileSelect={handleKeywordSearchFileSelect}
                onClose={handleCloseSearch}
                isActive={isSearchTabActive && !sidebarCollapsed}
              />
            }
          />
        }
        footer={
          <TabCodeStatusBar
            isGitRepo={isGitRepo}
            branch={branch}
            branchMeta={branchMeta}
            isLinkedWorktree={isLinkedWorktree}
            sidebarCollapsed={sidebarCollapsed}
            onOpenBranchOperations={() => setIsBranchOperationsOpen(true)}
            onFetch={isGitRepo ? handleStatusBarFetch : undefined}
            onPull={isGitRepo ? handleStatusBarPull : undefined}
            onPush={isGitRepo ? handleStatusBarPush : undefined}
            syncActionKey={statusBarSyncActionKey}
            onOpenWorktree={isGitRepo ? handleOpenWorktree : undefined}
            onOpenChanges={
              isGitRepo && tabScopeKey ? handleOpenChanges : undefined
            }
            changeStats={diffStat}
            onOpenHistory={isGitRepo ? handleOpenGitHistory : undefined}
            onToggleSidebar={handleToggleSidebar}
            onSwitchToFileBrowser={
              gitFlowSwitch ? handleSwitchToFileBrowser : undefined
            }
          />
        }
      >
        {validatedSessionKey === sessionKey &&
        (openFiles.length > 0 || previewFile || gitHistoryOpen) ? (
          <TabCodeEditorGroupLayout
            rootPath={rootPath}
            isPaneActive={isPaneActive}
            editorSessionKey={sessionKey ?? ''}
            workspace={editorWorkspace}
            previewFilesByGroup={previewFilesByGroup}
            previewActiveByGroup={previewActiveByGroup}
            isGitRepo={isGitRepo}
            gitStatusRevision={statusRevision}
            gitContentRevisions={contentRevisions}
            gitStatus={gitStatus}
            selectedLine={selectedLine}
            findRequest={findRequest}
            selectedGitDiffMode={previewGitDiffMode}
            onActivateGroup={handleActivateGroup}
            onActivateFile={handleActivateFile}
            onActivatePreview={handleActivatePreview}
            onPinPreview={handlePinPreview}
            onCloseFile={handleCloseFile}
            onMoveFile={handleMoveFile}
            onReorderFile={handleReorderFile}
            onSplitFile={handleSplitFile}
            onSplitResize={handleSplitResize}
            onFileSaved={refreshGit}
            onEditorStateChange={handleEditorStateChange}
            onFileDeleted={(filePath) => {
              if (sessionKey)
                pruneWorkspaceSessionPaths(sessionKey, [filePath]);
              setSelectedLine(undefined);
              setFindRequest(undefined);
              setSelectedGitDiffMode(undefined);
            }}
            onClearPreview={handleClearPreview}
            gitHistoryOpen={gitHistoryOpen}
            gitHistoryActive={gitHistoryActive}
            gitHistoryGroupId={
              gitHistoryGroupId
              && editorWorkspace.groupsById[gitHistoryGroupId]
                ? gitHistoryGroupId
                : ROOT_EDITOR_GROUP_ID
            }
            gitHistoryLabel={t('editorTabs.gitHistory')}
            gitHistoryRefreshToken={statusRevision}
            onActivateGitHistory={handleActivateGitHistory}
            onCloseGitHistory={handleCloseGitHistory}
            onMoveGitHistory={handleMoveGitHistory}
            onSplitGitHistory={handleSplitGitHistory}
          />
        ) : (
          <TabCodeRecentlyClosed
            rootPath={rootPath}
            recentlyClosedFiles={recentlyClosedFiles}
            onReopen={(filePath) => {
              void handleReopenFile(filePath);
            }}
          />
        )}
      </WorkdirPaneShell>

      {branch && (
        <BranchOperationsDialog
          open={isBranchOperationsOpen}
          onOpenChange={setIsBranchOperationsOpen}
          rootPath={rootPath}
          currentBranch={branch}
          onRefreshGit={refreshGit}
        />
      )}

      {/* Quick Open 对话框 */}
      <QuickOpenDialog
        open={isQuickOpenOpen}
        rootPath={rootPath}
        recentFiles={previewHistory}
        onSelect={handleFileSelect}
        onClose={() => setIsQuickOpenOpen(false)}
      />
    </>
  );
};

export default TabCodePaneHost;
