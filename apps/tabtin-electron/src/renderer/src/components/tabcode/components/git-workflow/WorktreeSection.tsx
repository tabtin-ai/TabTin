import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui';
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { TabCodeConfirmDialog } from '../TabCodeConfirmDialog';
import { normalizePathForCompare } from '../../utils/worktreePaths';
import { WorktreeCreateFields } from './WorktreeCreateFields';
import { useWorktreeLocation } from './useWorktreeLocation';
import {
  type BindSessionCodeRootFailureReason,
} from '@/services/sessionCodeRootBinding';
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore';
import { switchSessionWorktree } from '@components/context-space/code-workspace/switchSessionWorktree';
import { createLogger } from '@/utils/logger';
import { cn } from '@utils/cn';
import type { GitWorktreeItem } from './useGitWorkflowData';
import { NONE_VALUE } from './useGitWorkflowData';
import type { WorktreeRemovePreflightResult } from '@shared/git-types';
import {
  formatGitErrorForToast,
  formatGitWarningForToast,
} from './gitErrorMessage';

const log = createLogger('WorktreeSection');

const REASON_MESSAGE_KEY: Record<BindSessionCodeRootFailureReason, string> = {
  invalid_session_id: 'gitFlow.setSessionCodeRootReasonInvalidSession',
  invalid_root_path: 'gitFlow.setSessionCodeRootReasonInvalidPath',
  not_found: 'gitFlow.setSessionCodeRootReasonNotFound',
  not_a_directory: 'gitFlow.setSessionCodeRootReasonNotDirectory',
  not_git_worktree: 'gitFlow.setSessionCodeRootReasonNotGitWorktree',
  session_busy: 'gitFlow.setSessionCodeRootReasonSessionBusy',
  ipc_unavailable: 'gitFlow.setSessionCodeRootReasonIpcUnavailable',
};

interface WorktreeSectionProps {
  rootPath: string;
  branchNames: string[];
  worktrees: GitWorktreeItem[];
  currentBranchName: string;
  worktreeBaseBranch: string;
  setWorktreeBaseBranch: (v: string) => void;
  worktreeBranch: string;
  setWorktreeBranch: (v: string) => void;
  actionKey: string | null;
  runGitAction: (
    key: string,
    action: () => Promise<{
      success: boolean;
      error?: string;
      skippedPaths?: string[];
      skippedCount?: number;
    } | null>,
    successDesc: string,
  ) => Promise<boolean>;
  onOpenProjectPath?: (path: string) => void;
  onCloseDialog?: () => void;
  /** ：授权 worktree 路径（appendSessionAllowedPath）需要——缺省时跳过授权调用。 */
  spaceId?: string | null;
  /** ：「设为对话代码根」绑定目标会话——缺省时按钮点击提示无可用会话。 */
  sessionId?: string | null;
  /** 当前 TabCode 所属标签 scope；不可用全局前景会话替代。 */
  tabScopeKey?: string | null;
}

export const WorktreeSection: React.FC<WorktreeSectionProps> = ({
  rootPath,
  branchNames,
  worktrees,
  currentBranchName,
  worktreeBaseBranch,
  setWorktreeBaseBranch,
  worktreeBranch,
  setWorktreeBranch,
  actionKey,
  runGitAction,
  onOpenProjectPath,
  onCloseDialog,
  spaceId,
  sessionId,
  tabScopeKey,
}) => {
  const { t } = useTranslation('tabcode');

  // 默认开：关掉且分支还不存在时会 `git worktree add <path> <missing-ref>`。
  const [worktreeCreateBranch, setWorktreeCreateBranch] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingSessionRootPath, setSettingSessionRootPath] = useState<
    string | null
  >(null);

  const [confirmRemovePath, setConfirmRemovePath] = useState<string | null>(
    null,
  );
  const [forceRemove, setForceRemove] = useState<{
    path: string;
    assessmentToken: string;
  } | null>(null);

  // 会话绑定态：只读订阅，展示当前会话绑定到了哪个 worktree（高亮）。
  const sessionBinding = useSessionBoundCodeRootStore((s) =>
    sessionId ? (s.bindingsBySessionId[sessionId] ?? null) : null,
  );
  const hasActiveSessionBinding = sessionBinding?.status === 'active';
  const isBoundToSession = useCallback(
    (path: string) =>
      hasActiveSessionBinding &&
      normalizePathForCompare(sessionBinding!.rootPath) ===
        normalizePathForCompare(path),
    [hasActiveSessionBinding, sessionBinding],
  );

  // `git worktree list` 恒定把主工作树排在第一位（man git-worktree）；
  // 第一批只标「linked worktree」，不去猜测/伪造来源（TabTin 创建 vs 外部创建）。
  const mainWorktreePath = worktrees[0]?.path;
  const isLinkedWorktree = useCallback(
    (path: string) =>
      Boolean(mainWorktreePath) &&
      normalizePathForCompare(path) !==
        normalizePathForCompare(mainWorktreePath!),
    [mainWorktreePath],
  );

  const existingWorktreePaths = useMemo(
    () => worktrees.map((item) => item.path),
    [worktrees],
  );
  const location = useWorktreeLocation({
    repoRoot: rootPath,
    branch:
      worktreeBranch || worktreeBaseBranch || currentBranchName || 'branch',
    existingPaths: existingWorktreePaths,
    resetKey: createOpen,
  });

  const handleCreateWorktree = useCallback(async () => {
    const pathValue = location.fullPath.trim();
    if (!pathValue) {
      toast({
        title: t('gitFlow.errorTitle'),
        description: t('gitFlow.worktreePathRequired'),
      });
      return;
    }
    const branchValue = worktreeBranch.trim();
    const branchAlreadyExists =
      Boolean(branchValue) && branchNames.includes(branchValue);
    // 关掉「新建分支」却填了不存在的分支名 → 本地先拦，避免落到 git invalid reference。
    if (!worktreeCreateBranch && branchValue && !branchAlreadyExists) {
      toast({
        title: t('gitFlow.errorTitle'),
        description: t('gitFlow.worktreeBranchNotFound', {
          branch: branchValue,
        }),
      });
      return;
    }
    if (worktreeCreateBranch && !branchValue) {
      toast({
        title: t('gitFlow.errorTitle'),
        description: t('gitFlow.worktreeBranchRequired'),
      });
      return;
    }

    // ：新建 worktree 大多落在 Space working_dir 之外（sibling 目录），
    // session 授权是 spaceId 维度的已知限制（见 workspace-boundary.ts 顶部注释），
    // 本任务不重构授权维度，只是补上「创建前先授权」这一步，避免创建成功后
    // 文件树/终端因路径未授权而拒绝访问。
    if (spaceId) {
      try {
        await window.tabtin?.workspace?.appendSessionAllowedPath?.({
          spaceId,
          path: pathValue,
        });
      } catch (err) {
        log.warn('appendSessionAllowedPath before creating worktree failed', {
          errorType: err instanceof Error ? err.name : typeof err,
        });
        toast({
          title: t('gitFlow.errorTitle'),
          description: t('gitFlow.worktreeAuthorizeFailed'),
        });
        return;
      }
    }

    const baseBranch =
      worktreeBaseBranch && worktreeBaseBranch !== NONE_VALUE
        ? worktreeBaseBranch
        : undefined;
    const effectiveBranch =
      branchValue ||
      (!worktreeCreateBranch
        ? worktreeBaseBranch || currentBranchName || ''
        : '');

    const ok = await runGitAction(
      'create-worktree',
      () =>
        window.tabtin.git.createWorktree(rootPath, {
          path: pathValue,
          branch: effectiveBranch || undefined,
          createBranch: worktreeCreateBranch,
          baseBranch,
        }),
      t('gitFlow.createWorktreeSuccess'),
    );
    if (ok) {
      setCreateOpen(false);
    }
  }, [
    branchNames,
    currentBranchName,
    location.fullPath,
    rootPath,
    runGitAction,
    spaceId,
    t,
    worktreeBaseBranch,
    worktreeBranch,
    worktreeCreateBranch,
  ]);

  const handleSetSessionCodeRoot = useCallback(
    async (item: GitWorktreeItem) => {
      if (!sessionId) {
        toast({
          title: t('gitFlow.errorTitle'),
          description: t('gitFlow.setSessionCodeRootNoSession'),
        });
        return;
      }
      setSettingSessionRootPath(item.path);
      try {
        const result = await switchSessionWorktree({
          sessionId,
          spaceId: spaceId ?? '',
          tabScopeKey: tabScopeKey ?? '',
          rootPath: item.path,
          previousRootPath: sessionBinding?.rootPath ?? rootPath,
          branch: item.branch ?? undefined,
        });
        if (result.success) {
          const boundPath = result.rootPath ?? item.path;
          toast({
            title: t('gitFlow.successTitle'),
            description: t('gitFlow.setSessionCodeRootSuccess', {
              path: boundPath,
            }),
          });
          if (!item.isCurrent) {
            onCloseDialog?.();
            onOpenProjectPath?.(item.path);
          }
          return;
        }
        log.warn('bindSessionCodeRoot rejected', {
          reason: result.reason ?? 'unknown',
        });
        const reasonKey = result.reason
          ? REASON_MESSAGE_KEY[result.reason]
          : undefined;
        toast({
          title: t('gitFlow.errorTitle'),
          description: reasonKey
            ? t(reasonKey)
            : t('gitFlow.setSessionCodeRootReasonUnknown'),
        });
      } catch (err) {
        log.error('bindSessionCodeRoot threw', err);
        toast({
          title: t('gitFlow.errorTitle'),
          description: t('gitFlow.setSessionCodeRootReasonUnknown'),
        });
      } finally {
        setSettingSessionRootPath(null);
      }
    },
    [
      onCloseDialog,
      onOpenProjectPath,
      rootPath,
      sessionBinding?.rootPath,
      sessionId,
      spaceId,
      t,
      tabScopeKey,
    ],
  );

  const doRemoveWorktree = useCallback(
    async (
      path: string,
      options?: { force?: boolean; assessmentToken?: string },
    ) => {
      await runGitAction(
        `remove-worktree:${path}`,
        async () => {
          const result = await window.tabtin.git.removeWorktree(rootPath, {
            path,
            ...options,
          });
          if (result.success) {
            for (const sessionId of result.clearedSessionIds ?? []) {
              useSessionBoundCodeRootStore.getState().clearBinding(sessionId);
            }
            for (const warning of result.warnings ?? []) {
              toast({
                title: t('gitFlow.errorTitle'),
                description: formatGitWarningForToast(warning, t),
              });
            }
          }
          return result;
        },
        t('gitFlow.removeWorktreeSuccess'),
      );
    },
    [rootPath, runGitAction, t],
  );

  const handleRemoveRequest = useCallback(
    async (path: string) => {
      let result: WorktreeRemovePreflightResult;
      try {
        result = await window.tabtin.git.preflightRemoveWorktree(rootPath, {
          path,
        });
      } catch (error) {
        toast({
          title: t('gitFlow.errorTitle'),
          description: formatGitErrorForToast(error, t),
        });
        return;
      }
      if (
        result.reason === 'worktree_dirty' &&
        result.canForce &&
        result.assessmentToken
      ) {
        setForceRemove({ path, assessmentToken: result.assessmentToken });
        return;
      }
      if (!result.canRemove) {
        toast({
          title: t('gitFlow.errorTitle'),
          description: formatGitErrorForToast(result, t),
        });
        return;
      }
      await doRemoveWorktree(path, {
        assessmentToken: result.assessmentToken,
      });
    },
    [doRemoveWorktree, rootPath, t],
  );

  return (
    <TooltipProvider delayDuration={250}>
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h3 className="text-body font-medium">
                {t('gitFlow.existingWorktrees')}
              </h3>
            </div>
          </div>
          <Button
            type="button"
            variant={createOpen ? 'secondary' : 'outline'}
            size="sm"
            className="shrink-0"
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((value) => !value)}
          >
            {createOpen ? (
              <ChevronDown className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Plus className="mr-1 h-3.5 w-3.5" />
            )}
            {t('gitFlow.createWorktree')}
          </Button>
        </div>

        <div className="space-y-2">
          {worktrees.length === 0 ? (
            <p className="py-6 text-center text-body text-muted-foreground">
              {t('gitFlow.noWorktrees')}
            </p>
          ) : (
            worktrees.map((item) => {
              // 没有显式绑定时，主工作树就是当前会话的默认代码根；
              // 不再给它展示一个会把用户带回原处的「切换」按钮。
              const bound =
                isBoundToSession(item.path) ||
                (Boolean(sessionId) &&
                  !hasActiveSessionBinding &&
                  item.isCurrent);
              const linked = isLinkedWorktree(item.path);
              const settingThis = settingSessionRootPath === item.path;
              const branchLabel = item.branch || t('gitFlow.detached');
              return (
                <div
                  key={item.path}
                  className={cn(
                    'min-w-0 rounded-md border border-border/60 px-3 py-2.5 transition-colors',
                    bound && 'border-primary/60 bg-primary/[0.04]',
                  )}
                >
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="min-w-0 truncate text-body font-medium"
                          title={branchLabel}
                        >
                          {branchLabel}
                        </span>
                        {item.isCurrent && (
                          <Badge variant="outline" className="shrink-0">
                            {t('gitFlow.currentCodeDirectory')}
                          </Badge>
                        )}
                        {linked ? (
                          <Badge
                            variant={bound ? 'default' : 'secondary'}
                            className="shrink-0"
                          >
                            {t('gitFlow.linkedWorktreeBadge')}
                          </Badge>
                        ) : (
                          bound &&
                          !item.isCurrent && (
                            <Badge
                              variant="default"
                              className="shrink-0 gap-0.5"
                            >
                              <Check className="h-3 w-3" />
                              {t('gitFlow.setSessionCodeRootBoundBadge')}
                            </Badge>
                          )
                        )}
                      </div>
                      <div
                        className="mt-1 min-w-0 truncate text-caption text-muted-foreground"
                        title={item.path}
                      >
                        {item.path}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!bound && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              disabled={settingThis}
                              onClick={() =>
                                void handleSetSessionCodeRoot(item)
                              }
                              aria-label={t('gitFlow.switchToWorktree')}
                            >
                              {settingThis ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {t('gitFlow.switchToWorktree')}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {linked &&
                        !item.isMainWorktree &&
                        !item.isCurrent &&
                        !item.isLocked && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          disabled={Boolean(actionKey)}
                          onClick={() => setConfirmRemovePath(item.path)}
                          title={t('gitFlow.remove')}
                          aria-label={t('gitFlow.remove')}
                        >
                          {actionKey === `remove-worktree:${item.path}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {createOpen && (
          <div className="space-y-3 border-t border-border/60 pt-4">
            <WorktreeCreateFields
              i18nNs="tabcode"
              i18nPrefix="gitFlow"
              idPrefix="tabcode"
              branch={worktreeBranch}
              onBranchChange={setWorktreeBranch}
              createBranch={worktreeCreateBranch}
              onCreateBranchChange={setWorktreeCreateBranch}
              baseBranch={worktreeBaseBranch}
              onBaseBranchChange={setWorktreeBaseBranch}
              branchNames={branchNames}
              currentBranch={currentBranchName}
              location={location}
              disabled={Boolean(actionKey)}
            />
            <Button
              size="sm"
              disabled={Boolean(actionKey)}
              onClick={() => void handleCreateWorktree()}
            >
              {actionKey === 'create-worktree' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('gitFlow.createWorktree')}
            </Button>
          </div>
        )}

        <TabCodeConfirmDialog
          open={Boolean(confirmRemovePath)}
          onOpenChange={(v) => {
            if (!v) setConfirmRemovePath(null);
          }}
          title={t('gitFlow.worktreeSection')}
          description={t('gitFlow.confirmRemoveWorktree', {
            path: confirmRemovePath || '',
          })}
          variant="destructive"
          confirmLabel={t('gitFlow.remove')}
          onConfirm={() => {
            if (confirmRemovePath) void handleRemoveRequest(confirmRemovePath);
          }}
        />
        <TabCodeConfirmDialog
          open={Boolean(forceRemove)}
          onOpenChange={(v) => {
            if (!v) setForceRemove(null);
          }}
          title={t('gitFlow.worktreeSection')}
          description={t('gitFlow.confirmRemoveWorktreeDirty', {
            path: forceRemove?.path || '',
          })}
          variant="destructive"
          confirmLabel={t('gitFlow.remove')}
          onConfirm={() => {
            if (forceRemove) {
              void doRemoveWorktree(forceRemove.path, {
                force: true,
                assessmentToken: forceRemove.assessmentToken,
              });
              setForceRemove(null);
            }
          }}
        />
      </section>
    </TooltipProvider>
  );
};
