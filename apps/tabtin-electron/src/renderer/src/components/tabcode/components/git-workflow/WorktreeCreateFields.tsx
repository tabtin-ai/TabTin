import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@components/ui'
import { NONE_VALUE } from './useGitWorkflowData'
import type { useWorktreeLocation } from './useWorktreeLocation'

type WorktreeLocationState = ReturnType<typeof useWorktreeLocation>

export interface WorktreeCreateFieldsProps {
  i18nNs: 'context' | 'tabcode'
  i18nPrefix: 'codeWorkspace' | 'gitFlow'
  idPrefix: string
  branch: string
  onBranchChange: (value: string) => void
  createBranch: boolean
  onCreateBranchChange: (value: boolean) => void
  baseBranch: string
  onBaseBranchChange: (value: string) => void
  branchNames: string[]
  currentBranch?: string
  location: WorktreeLocationState
  disabled?: boolean
}

export const WorktreeCreateFields: React.FC<WorktreeCreateFieldsProps> = ({
  i18nNs,
  i18nPrefix,
  idPrefix,
  branch,
  onBranchChange,
  createBranch,
  onCreateBranchChange,
  baseBranch,
  onBaseBranchChange,
  branchNames,
  currentBranch,
  location,
  disabled = false,
}) => {
  const { t } = useTranslation(i18nNs)
  const tx = (key: string, defaultValue: string, values?: Record<string, string>) =>
    t(`${i18nPrefix}.${key}`, { defaultValue, ...values })

  const pendingPreview = createBranch && !branch.trim()
  const branchInputId = `${idPrefix}-worktree-branch`
  const folderNameId = `${idPrefix}-worktree-folder-name`

  const handleCreateBranchChange = (next: boolean) => {
    onCreateBranchChange(next)
    if (next) return
    const current = branch.trim()
    if (current && branchNames.includes(current)) return
    if (currentBranch && branchNames.includes(currentBranch)) {
      onBranchChange(currentBranch)
      return
    }
    onBranchChange(branchNames[0] ?? '')
  }

  const handlePickParent = async () => {
    const picker = window.tabtin?.showOpenDialog
    if (!picker) {
      toast({
        title: tx('worktreePickFolderUnavailable', '文件夹选择器不可用，请稍后重试'),
        variant: 'destructive',
      })
      return
    }
    const picked = await picker({
      properties: ['openDirectory'],
      ...(location.parent ? { defaultPath: location.parent } : {}),
    })
    if (!picked?.[0]) return
    location.setParent(picked[0])
  }

  return (
    <div className="space-y-3" data-testid="worktree-create-fields">
      <div className="space-y-1.5">
        <Label htmlFor={createBranch ? branchInputId : undefined}>
          {tx('worktreeBranch', '分支')}
        </Label>
        {createBranch ? (
          <Input
            id={branchInputId}
            value={branch}
            onChange={(event) => onBranchChange(event.target.value)}
            placeholder={tx('worktreeBranchPlaceholder', '例如：feat/login')}
            disabled={disabled}
          />
        ) : (
          <Select
            value={branch || NONE_VALUE}
            onValueChange={(value) => onBranchChange(value === NONE_VALUE ? '' : value)}
            disabled={disabled}
          >
            <SelectTrigger
              className="min-w-0 whitespace-nowrap"
              title={branch || tx('worktreeSelectExistingBranch', '选择已有分支')}
            >
              <SelectValue
                className="min-w-0 truncate whitespace-nowrap"
                placeholder={tx('worktreeSelectExistingBranch', '选择已有分支')}
              />
            </SelectTrigger>
            <SelectContent>
              {branchNames.map((name) => (
                <SelectItem
                  key={`${idPrefix}-existing-${name}`}
                  value={name}
                  className="whitespace-nowrap"
                  title={name}
                >
                  <span className="block max-w-full truncate whitespace-nowrap">
                    {name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="text-body font-medium">
            {tx('createNewBranchForWorktree', '为关联 worktree 新建分支')}
          </div>
          <div className="text-caption text-muted-foreground">
            {tx(
              'createNewBranchForWorktreeHint',
              '默认开启：按上方分支名新建；关闭后只能检出已有分支',
            )}
          </div>
        </div>
        <Switch
          checked={createBranch}
          disabled={disabled}
          onCheckedChange={handleCreateBranchChange}
        />
      </div>

      <div className="space-y-1.5">
        <Label>{tx('worktreeBaseBranch', '基准分支')}</Label>
        <Select
          value={baseBranch || NONE_VALUE}
          onValueChange={(value) => onBaseBranchChange(value === NONE_VALUE ? '' : value)}
          disabled={disabled}
        >
          <SelectTrigger
            className="min-w-0 whitespace-nowrap"
            title={baseBranch || tx('selectBaseBranch', '选择基准分支')}
          >
            <SelectValue
              className="min-w-0 truncate whitespace-nowrap"
              placeholder={tx('selectBaseBranch', '选择基准分支')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE} className="whitespace-nowrap">
              {tx('none', '无')}
            </SelectItem>
            {branchNames.map((name) => (
              <SelectItem
                key={`${idPrefix}-base-${name}`}
                value={name}
                className="whitespace-nowrap"
                title={name}
              >
                <span className="block max-w-full truncate whitespace-nowrap">
                  {name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {location.locationOpen ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={folderNameId}>
              {tx('worktreeFolderName', '目录名')}
            </Label>
            <Input
              id={folderNameId}
              value={location.folderName}
              onChange={(event) => location.setFolderName(event.target.value)}
              disabled={disabled}
              data-testid="worktree-folder-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tx('worktreeParentFolder', '位置')}</Label>
            <div className="flex items-center gap-2">
              <div
                className="min-w-0 flex-1 truncate text-body text-muted-foreground"
                title={location.parent}
                data-testid="worktree-parent-folder"
              >
                {location.parent || '—'}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={disabled}
                data-testid="worktree-pick-parent"
                onClick={() => void handlePickParent()}
              >
                {tx('worktreePickFolder', '选择…')}
              </Button>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-0 text-caption text-muted-foreground"
            disabled={disabled}
            onClick={() => location.setLocationOpen(false)}
          >
            {tx('worktreeCollapseLocation', '收起')}
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <div
            className="truncate text-body"
            title={pendingPreview ? undefined : location.fullPath}
            data-testid="worktree-location-preview"
          >
            {pendingPreview
              ? tx('worktreeDirectoryPreviewPending', '填写分支后将自动生成目录名')
              : tx('worktreeDirectoryPreview', '将创建目录 {{name}}', {
                  name: location.folderName,
                })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-caption text-muted-foreground">
              {tx('worktreeDirectoryHint', '放在当前仓库旁边，工作空间主目录不变')}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto shrink-0 px-0 text-caption"
              disabled={disabled}
              data-testid="worktree-change-location"
              onClick={() => location.setLocationOpen(true)}
            >
              {tx('worktreeChangeLocation', '改位置')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
