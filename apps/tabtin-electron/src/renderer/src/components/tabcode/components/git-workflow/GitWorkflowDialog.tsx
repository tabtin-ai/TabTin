/**
 * @deprecated TabCode 主路径已改为侧栏 GitWorkflowPanel。
 * 本 Dialog 仅保留给测试 / 外部程序化打开；勿在 TabCodePaneHost 再挂载。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  toast,
} from '@components/ui';
import {
  ArrowDownToLine,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useGitWorkflowData, type GitOutcomeCard } from './useGitWorkflowData';
import { ChangesPanel } from './ChangesPanel';
import { CommitBar, type GitActionPresentation } from './CommitBar';
import { AdvancedSheet } from './AdvancedSheet';
import { formatGitErrorForToast } from './gitErrorMessage';
import { logGitActionFailure } from '../../utils/gitActionDiagnostics';
import { useWorktreeDialogStore } from './useWorktreeDialogStore';

function diffStatusClass(status: string): string {
  switch (status.toUpperCase()) {
    case 'A':
      return 'text-success';
    case 'D':
      return 'text-destructive';
    case 'R':
      return 'text-info';
    case 'U':
      return 'text-warning';
    default:
      return 'text-warning';
  }
}

interface TabCodeGitWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootPath: string;
  currentBranch: string | null;
  stagedCount: number;
  unstagedCount: number;
  onRefreshGit: () => void | Promise<void>;
  onOpenProjectPath?: (path: string) => void;
  advancedOpen?: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
}

export const TabCodeGitWorkflowDialog: React.FC<
  TabCodeGitWorkflowDialogProps
> = ({
  open,
  onOpenChange,
  rootPath,
  currentBranch,
  stagedCount,
  unstagedCount,
  onRefreshGit,
  onOpenProjectPath,
  advancedOpen: advancedOpenProp,
  onAdvancedOpenChange,
}) => {
  const { t } = useTranslation('tabcode');
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [latestOutcome] = useState<GitOutcomeCard | null>(null);
  const internalDialogOwnerId = `legacy:${rootPath}`;
  const internalAdvancedOpen = useWorktreeDialogStore(
    (state) => state.openOwnerId === internalDialogOwnerId,
  );
  const setInternalDialogOpen = useWorktreeDialogStore(
    (state) => state.setOpen,
  );
  const setInternalAdvancedOpen = useCallback(
    (nextOpen: boolean) =>
      setInternalDialogOpen(internalDialogOwnerId, nextOpen),
    [internalDialogOwnerId, setInternalDialogOpen],
  );
  const advancedOpen = advancedOpenProp ?? internalAdvancedOpen;
  const setAdvancedOpen = onAdvancedOpenChange ?? setInternalAdvancedOpen;

  const data = useGitWorkflowData({ rootPath, currentBranch, open });

  const outcomeTopFiles = useMemo(
    () => latestOutcome?.summary?.files.slice(0, 6) || [],
    [latestOutcome],
  );

  const runGitAction = useCallback(
    async (
      key: string,
      action: () => Promise<{
        success: boolean;
        error?: string;
        skippedPaths?: string[];
        skippedCount?: number;
      } | null>,
      successDesc: string,
      presentation?: GitActionPresentation,
    ) => {
      setActionKey(key);
      try {
        const result = await action();
        if (result?.success) {
          let refreshFailed = false;
          try {
            await onRefreshGit();
            await data.loadData();
          } catch (refreshError) {
            refreshFailed = true;
            logGitActionFailure(
              `workflow:${key}:refresh`,
              rootPath,
              [],
              refreshError,
            );
          }
          if (presentation?.showSuccessToast !== false) {
            const skippedCount =
              result.skippedCount ?? result.skippedPaths?.length ?? 0;
            const skippedDesc =
              skippedCount > 0
                ? key.startsWith('unstage')
                  ? t('gitFlow.unstageSkippedDenied', { count: skippedCount })
                  : t('gitFlow.stageSkippedDenied', { count: skippedCount })
                : null;
            toast({
              title: t('gitFlow.successTitle'),
              description: refreshFailed
                ? t('gitFlow.actionSucceededRefreshFailed', {
                    action: skippedDesc ?? successDesc,
                  })
                : (skippedDesc ?? successDesc),
            });
          }
          return true;
        }
        logGitActionFailure(`workflow:${key}`, rootPath, [], result?.error);
        toast({
          title: t('gitFlow.errorTitle'),
          description:
            presentation?.formatError?.(result?.error) ??
            formatGitErrorForToast(result, t),
        });
        return false;
      } catch (error) {
        logGitActionFailure(`workflow:${key}`, rootPath, [], error);
        toast({
          title: t('gitFlow.errorTitle'),
          description:
            presentation?.formatError?.(error) ??
            formatGitErrorForToast(error, t),
        });
        return false;
      } finally {
        setActionKey(null);
      }
    },
    [data, onRefreshGit, rootPath, t],
  );

  const handlePull = useCallback(async () => {
    const upstream = data.branchMeta.upstream || '';
    const remote = upstream.includes('/') ? upstream.split('/')[0] : 'origin';
    await runGitAction(
      'pull',
      () => window.tabtin.git.pull(rootPath, { remote }),
      t('gitFlow.pullSuccess'),
    );
  }, [data.branchMeta.upstream, rootPath, runGitAction, t]);

  const handleFetch = useCallback(async () => {
    await runGitAction(
      'fetch',
      () => window.tabtin.git.fetch(rootPath),
      t('gitFlow.fetchSuccess'),
    );
  }, [rootPath, runGitAction, t]);

  const repoFolderName = useMemo(() => {
    const segments = rootPath.split('/').filter(Boolean);
    return segments[segments.length - 1] || rootPath;
  }, [rootPath]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[760px]">
          <DialogHeader>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground/80" />
                <span>Git</span>
                <span className="text-muted-foreground/60">·</span>
                <span className="truncate font-medium">
                  {data.currentBranchName || t('gitFlow.none')}
                </span>
                {(data.branchMeta.ahead > 0 || data.branchMeta.behind > 0) && (
                  <span className="text-caption text-muted-foreground/80 tabular-nums">
                    ↑{data.branchMeta.ahead} ↓{data.branchMeta.behind}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="truncate">
                {repoFolderName}
              </DialogDescription>
            </div>
          </DialogHeader>

          <ScrollArea className="max-h-[72vh] pr-1">
            {/* @container/tabcode-git：CommitBar/ChangesPanel 的容器查询兜底，宽 Dialog 落宽档 */}
            <div className="space-y-3 @container/tabcode-git">
              <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/[0.10] p-3">
                <span className="mr-auto text-body font-medium">
                  {t('gitFlow.syncSection')}
                </span>
                {data.branchMeta.upstream && (
                  <span className="max-w-[240px] truncate text-caption text-muted-foreground/60">
                    {t('gitFlow.upstreamHint', {
                      upstream: data.branchMeta.upstream,
                    })}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={data.isLoading || Boolean(actionKey)}
                  onClick={() => void handlePull()}
                >
                  {actionKey === 'pull' ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('gitFlow.pull')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={data.isLoading || Boolean(actionKey)}
                  onClick={() => void handleFetch()}
                >
                  {actionKey === 'fetch' ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('gitFlow.fetch')}
                </Button>
              </section>

              <CommitBar
                rootPath={rootPath}
                currentBranchName={data.currentBranchName}
                branchMeta={data.branchMeta}
                stagedCount={stagedCount}
                unstagedCount={unstagedCount}
                actionKey={actionKey}
                runGitAction={runGitAction}
              />

              {latestOutcome && (
                <div className="rounded-lg border border-border/60 bg-muted/[0.10] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium">
                        {latestOutcome.title}
                      </div>
                      <div className="truncate text-body text-muted-foreground">
                        {latestOutcome.subtitle}
                      </div>
                    </div>
                    <span className="rounded-md bg-background/80 px-2 py-0.5 text-caption text-muted-foreground">
                      {latestOutcome.kind === 'pr'
                        ? t('gitFlow.prTag')
                        : t('gitFlow.mergeTag')}
                    </span>
                  </div>

                  {latestOutcome.summary && (
                    <div className="mt-2 flex items-baseline gap-3 text-caption text-muted-foreground">
                      <span>
                        <span className="tabular-nums text-foreground">
                          {latestOutcome.summary.filesChanged}
                        </span>{' '}
                        {t('gitFlow.outcomeFilesChanged')}
                      </span>
                      <span className="tabular-nums text-success">
                        +{latestOutcome.summary.insertions}
                      </span>
                      <span className="tabular-nums text-destructive">
                        −{latestOutcome.summary.deletions}
                      </span>
                    </div>
                  )}

                  {outcomeTopFiles.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {outcomeTopFiles.map((file) => (
                        <div
                          key={`${latestOutcome.timestamp}-${file.path}`}
                          className="flex items-center gap-2 rounded border border-border/40 bg-background/40 px-2 py-1"
                        >
                          <span
                            className={`w-4 text-center text-caption font-semibold ${diffStatusClass(file.status)}`}
                          >
                            {file.status}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-caption">
                            {file.path}
                          </span>
                          <span className="text-caption tabular-nums text-success">
                            +{file.added}
                          </span>
                          <span className="text-caption tabular-nums text-destructive">
                            −{file.deleted}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {latestOutcome.link && (
                    <button
                      type="button"
                      className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                      onClick={() =>
                        void window.tabtin.openExternal(latestOutcome.link!)
                      }
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span>{t('gitFlow.openResultLink')}</span>
                    </button>
                  )}
                </div>
              )}

              <ChangesPanel
                rootPath={rootPath}
                files={data.files}
                groups={data.groups}
                isLoading={data.isLoading}
                actionKey={actionKey}
                runGitAction={runGitAction}
              />
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <AdvancedSheet
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        rootPath={rootPath}
        branchNames={data.branchNames}
        worktrees={data.worktrees}
        currentBranchName={data.currentBranchName}
        worktreeBaseBranch={data.worktreeBaseBranch}
        setWorktreeBaseBranch={data.setWorktreeBaseBranch}
        worktreeBranch={data.worktreeBranch}
        setWorktreeBranch={data.setWorktreeBranch}
        actionKey={actionKey}
        runGitAction={runGitAction}
        onOpenProjectPath={onOpenProjectPath}
        onCloseDialog={() => setAdvancedOpen(false)}
      />
    </>
  );
};

export default TabCodeGitWorkflowDialog;
