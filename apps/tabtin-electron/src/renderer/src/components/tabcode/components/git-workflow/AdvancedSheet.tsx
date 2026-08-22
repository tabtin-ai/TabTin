import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
} from '@components/ui';
import { WorktreeSection } from './WorktreeSection';
import type { GitWorktreeItem } from './useGitWorkflowData';

export interface AdvancedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    action: () => Promise<{ success: boolean; error?: string } | null>,
    successDesc: string,
  ) => Promise<boolean>;
  onOpenProjectPath?: (path: string) => void;
  onCloseDialog?: () => void;
  /** ：授权 worktree 路径（appendSessionAllowedPath）需要。 */
  spaceId?: string | null;
  /** ：「设为对话代码根」绑定目标会话。 */
  sessionId?: string | null;
  /** 当前 TabCode 所属标签 scope。 */
  tabScopeKey?: string | null;
}

/**
 * Worktree 管理 Dialog。
 *
 * 这个组件沿用旧文件名，避免影响外部程序化入口；视觉上不再是右侧 Sheet，
 * 也不再承载同步或分支操作。
 */
export const AdvancedSheet: React.FC<AdvancedSheetProps> = ({
  open,
  onOpenChange,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[92vw] max-w-[720px] flex-col p-0">
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t('gitFlow.worktreePanel')}</DialogTitle>
          <DialogDescription>
            {t('gitFlow.worktreeDialogDesc')}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[78vh] px-6 pb-6">
          <WorktreeSection
            rootPath={rootPath}
            branchNames={branchNames}
            worktrees={worktrees}
            currentBranchName={currentBranchName}
            worktreeBaseBranch={worktreeBaseBranch}
            setWorktreeBaseBranch={setWorktreeBaseBranch}
            worktreeBranch={worktreeBranch}
            setWorktreeBranch={setWorktreeBranch}
            actionKey={actionKey}
            runGitAction={runGitAction}
            onOpenProjectPath={onOpenProjectPath}
            onCloseDialog={onCloseDialog}
            spaceId={spaceId}
            sessionId={sessionId}
            tabScopeKey={tabScopeKey}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default AdvancedSheet;
