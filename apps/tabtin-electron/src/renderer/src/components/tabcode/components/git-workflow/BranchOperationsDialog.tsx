import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  toast,
} from '@components/ui'
import { GitBranch } from 'lucide-react'
import { BranchSection } from './BranchSection'
import { formatGitErrorForToast } from './gitErrorMessage'
import { useGitWorkflowData } from './useGitWorkflowData'
import { logGitActionFailure } from '../../utils/gitActionDiagnostics'

interface BranchOperationsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootPath: string
  currentBranch: string
  onRefreshGit: () => Promise<void> | void
}

export const BranchOperationsDialog: React.FC<BranchOperationsDialogProps> = ({
  open,
  onOpenChange,
  rootPath,
  currentBranch,
  onRefreshGit,
}) => {
  const { t } = useTranslation('tabcode')
  const [actionKey, setActionKey] = useState<string | null>(null)
  const data = useGitWorkflowData({ rootPath, currentBranch, open })

  const stagedCount = useMemo(
    () => data.files.filter(file => file.staged).length,
    [data.files],
  )
  const unstagedCount = useMemo(
    () => data.files.filter(file => file.unstaged).length,
    [data.files],
  )
  const untrackedCount = useMemo(
    () => data.files.filter(file => file.untracked).length,
    [data.files],
  )

  const runGitAction = useCallback(
    async (key: string, action: () => Promise<{ success: boolean; error?: string } | null>, successDesc: string) => {
      setActionKey(key)
      try {
        const result = await action()
        if (result?.success) {
          toast({ title: t('gitFlow.successTitle'), description: successDesc })
          await onRefreshGit()
          await data.loadData()
          return true
        }
        logGitActionFailure(`branch-dialog:${key}`, rootPath, [], result?.error)
        toast({ title: t('gitFlow.errorTitle'), description: formatGitErrorForToast(result, t) })
        return false
      } catch (error) {
        logGitActionFailure(`branch-dialog:${key}`, rootPath, [], error)
        toast({ title: t('gitFlow.errorTitle'), description: formatGitErrorForToast(error, t) })
        return false
      } finally {
        setActionKey(null)
      }
    },
    [data, onRefreshGit, rootPath, t],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground/80" aria-hidden />
            <span>{t('gitFlow.branchSection')}</span>
            <span className="truncate text-body font-normal text-muted-foreground">
              {data.currentBranchName}
            </span>
          </DialogTitle>
          <DialogDescription>{t('gitFlow.branchDialogDesc')}</DialogDescription>
        </DialogHeader>

        <section className="space-y-3 rounded-lg bg-muted/10 p-3">
          <BranchSection
            rootPath={rootPath}
            branchNames={data.branchNames}
            currentBranchName={data.currentBranchName}
            stagedCount={stagedCount}
            unstagedCount={unstagedCount}
            dirtyFileCount={data.files.length}
            untrackedCount={untrackedCount}
            checkoutBranch={data.checkoutBranch}
            setCheckoutBranch={data.setCheckoutBranch}
            newBranchBase={data.newBranchBase}
            setNewBranchBase={data.setNewBranchBase}
            actionKey={data.isLoading ? 'loading' : actionKey}
            runGitAction={runGitAction}
          />
        </section>
      </DialogContent>
    </Dialog>
  )
}

export default BranchOperationsDialog
