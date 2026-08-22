import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui'
import { formatGitErrorForToast } from '@components/tabcode/components/git-workflow/gitErrorMessage'
import { NONE_VALUE } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import { WorktreeCreateFields } from '@components/tabcode/components/git-workflow/WorktreeCreateFields'
import { useWorktreeLocation } from '@components/tabcode/components/git-workflow/useWorktreeLocation'
import { createSessionWorktree } from './createSessionWorktree'
import type { CreateWorktreeValidationReason } from './validateCreateWorktreeInput'

interface CreateWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoRoot: string
  currentBranch: string
  branchNames: string[]
  existingWorktreePaths: string[]
  defaultBaseBranch: string
  sessionId: string
  spaceId: string
  tabScopeKey: string
  previousRootPath: string
  disabled?: boolean
  onCreated: (result: { rootPath: string; switched: boolean }) => void
  onError: (message: string) => void
}

const VALIDATE_I18N_KEY: Record<CreateWorktreeValidationReason, string> = {
  path_required: 'codeWorkspace.worktreePathRequired',
  branch_required: 'codeWorkspace.worktreeBranchRequired',
  branch_not_found: 'codeWorkspace.worktreeBranchNotFound',
}

export const CreateWorktreeDialog: React.FC<CreateWorktreeDialogProps> = ({
  open,
  onOpenChange,
  repoRoot,
  currentBranch,
  branchNames,
  existingWorktreePaths,
  defaultBaseBranch,
  sessionId,
  spaceId,
  tabScopeKey,
  previousRootPath,
  disabled = false,
  onCreated,
  onError,
}) => {
  const { t } = useTranslation('context')
  const { t: tTabcode } = useTranslation('tabcode')
  const [branch, setBranch] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [createBranch, setCreateBranch] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setBranch('')
    setBaseBranch(defaultBaseBranch)
    setCreateBranch(true)
    setSubmitting(false)
  }, [open, defaultBaseBranch])

  const location = useWorktreeLocation({
    repoRoot,
    branch: branch || baseBranch || currentBranch || 'branch',
    existingPaths: existingWorktreePaths,
    resetKey: open,
  })

  const handleSubmit = async () => {
    if (submitting || disabled) return
    setSubmitting(true)
    try {
      const result = await createSessionWorktree({
        sessionId,
        spaceId,
        tabScopeKey,
        repoRoot,
        previousRootPath,
        path: location.fullPath,
        branch,
        createBranch,
        baseBranch: baseBranch && baseBranch !== NONE_VALUE ? baseBranch : undefined,
        currentBranch,
        existingBranchNames: branchNames,
      })
      if (!result.ok) {
        if (result.phase === 'validate') {
          onError(
            result.reason === 'branch_not_found'
              ? t(VALIDATE_I18N_KEY[result.reason], {
                  defaultValue: '分支还不存在。请打开「为关联 worktree 新建分支」，或改成已有分支名。',
                  branch: branch.trim(),
                })
              : t(VALIDATE_I18N_KEY[result.reason], {
                  defaultValue: '请先填写必填项',
                }),
          )
          return
        }
        if (result.phase === 'authorize') {
          onError(t('codeWorkspace.worktreeAuthorizeFailed', {
            defaultValue: '路径授权失败，请重试',
          }))
          return
        }
        if (result.phase === 'ipc') {
          onError(t('codeWorkspace.bindReason.ipcUnavailable', {
            defaultValue: '本地能力未就绪，请稍后重试',
          }))
          return
        }
        onError(
          formatGitErrorForToast(result.error, tTabcode)
          || t('codeWorkspace.createWorktreeFailed', {
            defaultValue: '创建关联 worktree 失败',
          }),
        )
        return
      }
      onCreated({ rootPath: result.rootPath, switched: result.switched })
      onOpenChange(false)
    } catch (err) {
      onError(
        formatGitErrorForToast(err instanceof Error ? err.message : undefined, tTabcode)
        || t('codeWorkspace.createWorktreeFailed', {
          defaultValue: '创建关联 worktree 失败',
        }),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (submitting) return
      onOpenChange(next)
    }}>
      <DialogContent
        className="sm:max-w-[440px]"
        container={null}
        data-testid="code-workspace-create-worktree-dialog"
        onOpenAutoFocus={(event) => {
          const root = event.currentTarget as HTMLElement
          const input = root.querySelector('input')
          if (input instanceof HTMLInputElement) {
            event.preventDefault()
            input.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('codeWorkspace.createWorktreeTitle', { defaultValue: '新增关联 worktree' })}
          </DialogTitle>
          <DialogDescription>
            {t('codeWorkspace.createWorktreeDesc', {
              defaultValue: '会为当前仓库新建一个关联 worktree，并切到当前对话。工作空间主目录不变。',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-1">
          <WorktreeCreateFields
            i18nNs="context"
            i18nPrefix="codeWorkspace"
            idPrefix="code-workspace"
            branch={branch}
            onBranchChange={setBranch}
            createBranch={createBranch}
            onCreateBranchChange={setCreateBranch}
            baseBranch={baseBranch}
            onBaseBranchChange={setBaseBranch}
            branchNames={branchNames}
            currentBranch={currentBranch}
            location={location}
            disabled={submitting}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('codeWorkspace.cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || disabled}
            data-testid="code-workspace-create-and-switch"
            onClick={() => void handleSubmit()}
          >
            {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {t('codeWorkspace.createAndSwitch', { defaultValue: '创建并切换' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
