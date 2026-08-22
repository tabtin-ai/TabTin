import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@tabtin/smartsheet-ui'
import { Loader2 } from 'lucide-react'
import { TabCodeConfirmDialog } from '../TabCodeConfirmDialog'
import { NONE_VALUE } from './useGitWorkflowData'
import { checkoutSessionBranch } from '@components/context-space/code-workspace/checkoutSessionBranch'

export interface BranchSectionProps {
  rootPath: string
  branchNames: string[]
  currentBranchName: string
  stagedCount: number
  unstagedCount: number
  /** porcelain 中有状态的路径总数，包含冲突项。 */
  dirtyFileCount?: number
  /** 未跟踪文件数；缺省时退化为无法识别「仅未跟踪」 */
  untrackedCount?: number
  checkoutBranch: string
  setCheckoutBranch: (v: string) => void
  newBranchBase: string
  setNewBranchBase: (v: string) => void
  actionKey: string | null
  runGitAction: (key: string, action: () => Promise<any>, successDesc: string) => Promise<boolean>
}

export const BranchSection: React.FC<BranchSectionProps> = ({
  rootPath,
  branchNames,
  currentBranchName: _currentBranchName,
  stagedCount,
  unstagedCount,
  dirtyFileCount,
  untrackedCount = 0,
  checkoutBranch,
  setCheckoutBranch,
  newBranchBase,
  setNewBranchBase,
  actionKey,
  runGitAction,
}) => {
  const { t } = useTranslation('tabcode')
  const [newBranchName, setNewBranchName] = useState('')
  const [confirmStash, setConfirmStash] = useState(false)
  const [pendingCheckoutBranch, setPendingCheckoutBranch] = useState('')

  const attemptCheckout = useCallback(async (branch: string, confirmedStash: boolean) => {
    const result = await checkoutSessionBranch({
      rootPath,
      branch,
      stagedCount,
      unstagedCount,
      dirtyFileCount: dirtyFileCount ?? stagedCount + unstagedCount,
      untrackedCount,
      confirmedStash,
      t,
    })
    if (result.needsStashConfirm) {
      setPendingCheckoutBranch(branch)
      setConfirmStash(true)
      return false
    }
    return runGitAction(
      'checkout',
      async () => ({
        success: Boolean(result.success),
        error: result.error,
      }),
      t('gitFlow.checkoutSuccess', { branch }),
    )
  }, [dirtyFileCount, rootPath, stagedCount, unstagedCount, untrackedCount, t, runGitAction])

  const handleCheckoutBranch = useCallback(async () => {
    const branch = checkoutBranch.trim()
    if (!branch) return
    await attemptCheckout(branch, false)
  }, [checkoutBranch, attemptCheckout])

  const handleConfirmStashAndCheckout = useCallback(async () => {
    const branch = pendingCheckoutBranch.trim()
    if (!branch) return
    const ok = await attemptCheckout(branch, true)
    if (ok) {
      setConfirmStash(false)
      setPendingCheckoutBranch('')
    }
  }, [pendingCheckoutBranch, attemptCheckout])

  const handleCreateBranch = useCallback(async () => {
    const branch = newBranchName.trim()
    if (!branch) {
      toast({ title: t('gitFlow.errorTitle'), description: t('gitFlow.newBranchRequired') })
      return
    }
    const startPoint = newBranchBase && newBranchBase !== NONE_VALUE ? newBranchBase : undefined
    const ok = await runGitAction(
      'create-branch',
      () => window.tabtin.git.checkoutBranch(rootPath, { branch, create: true, startPoint }),
      t('gitFlow.createBranchSuccess', { branch }),
    )
    if (ok) {
      setNewBranchName('')
      setCheckoutBranch(branch)
    }
  }, [newBranchBase, newBranchName, rootPath, runGitAction, setCheckoutBranch, t])

  return (
    <>
      <h3 className="text-body font-medium">{t('gitFlow.branchSection')}</h3>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label>{t('gitFlow.checkoutBranch')}</Label>
          <Select value={checkoutBranch || NONE_VALUE} onValueChange={(v) => setCheckoutBranch(v === NONE_VALUE ? '' : v)}>
            <SelectTrigger><SelectValue placeholder={t('gitFlow.selectBranch')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>{t('gitFlow.none')}</SelectItem>
              {branchNames.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="form" disabled={Boolean(actionKey) || !checkoutBranch} onClick={() => void handleCheckoutBranch()}>
          {actionKey === 'checkout' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          {t('gitFlow.checkout')}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_160px_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="tabcode-new-branch">{t('gitFlow.newBranch')}</Label>
          <Input
            id="tabcode-new-branch"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder={t('gitFlow.newBranchPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('gitFlow.baseBranch')}</Label>
          <Select value={newBranchBase || NONE_VALUE} onValueChange={(v) => setNewBranchBase(v === NONE_VALUE ? '' : v)}>
            <SelectTrigger><SelectValue placeholder={t('gitFlow.selectBaseBranch')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>{t('gitFlow.none')}</SelectItem>
              {branchNames.map(name => <SelectItem key={`create-${name}`} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="form" disabled={Boolean(actionKey)} onClick={() => void handleCreateBranch()}>
          {actionKey === 'create-branch' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          {t('gitFlow.createBranch')}
        </Button>
      </div>

      <TabCodeConfirmDialog
        open={confirmStash}
        onOpenChange={setConfirmStash}
        title={t('gitFlow.branchSection')}
        description={t('gitFlow.stashAndCheckout')}
        confirmLabel={t('gitFlow.checkout')}
        disabled={Boolean(actionKey)}
        onConfirm={() => void handleConfirmStashAndCheckout()}
      />
    </>
  )
}
