import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
} from '@components/ui'
import { ContextDialogHeader } from '../ContextDialogHeader'
import {
  markDirtyExitConfirmSaving,
  setDirtyExitConfirmProgress,
  settleDirtyExitConfirm,
  useDirtyExitConfirmStore,
} from './dirtyExitConfirmStore'
import { saveAllDirty } from '../dirtyRegistry'
import type { DirtyResource } from '../dirtyRegistry'

/**
 * 退出 / 删除 Space 时的合并 dirty 对话框 Host
 *
 * 挂在 App 根级（与 TabdocCloseConfirmHost 同级）。
 * 由 dirtyExitConfirmStore 通过 promise + zustand 桥接调起。
 *
 * 三种交互：
 * - 取消         → settle('cancel')         → 调用方阻止退出 / 删除
 * - 全部放弃     → settle('discard')        → 调用方继续退出 / 删除
 * - 全部保存并继续 → 进入 saving phase → saveAllDirty → settle('save-all', results)
 *
 * saving phase 期间按钮禁用，进度条显示 "正在保存 X / Y..."。
 * 任意一条保存失败时**继续**保存其他（"继续 + 最后汇总"策略），
 * 调用方根据 saveResults 决定是否中止退出 / 仅 toast 警告。
 */
export function DirtyExitConfirmHost(): React.ReactElement {
  const { t } = useTranslation('context')
  const open = useDirtyExitConfirmStore((s) => s.open)
  const resources = useDirtyExitConfirmStore((s) => s.resources)
  const reason = useDirtyExitConfirmStore((s) => s.reason)
  const spaceName = useDirtyExitConfirmStore((s) => s.spaceName)
  const phase = useDirtyExitConfirmStore((s) => s.phase)
  const progress = useDirtyExitConfirmStore((s) => s.progress)

  const isSaving = phase === 'saving'

  const titleText = useMemo(() => {
    switch (reason) {
      case 'space-delete':
        return t('dirtyExitConfirm.title.spaceDelete', {
          defaultValue: '删除前确认未保存改动',
        })
      case 'window-close':
        return t('dirtyExitConfirm.title.windowClose', {
          defaultValue: '关闭窗口前确认未保存改动',
        })
      case 'app-relaunch':
        // Wave 1 第二轮：Agent 调 relaunch_app 时复用此对话框。
        // 用户语境是"重启"而非"退出"——必须分支文案，否则用户看到"退出前
        // 确认"会出现"我刚才不是说让你重启吗？怎么变成退出了？"的认知断裂。
        return t('dirtyExitConfirm.title.appRelaunch', {
          defaultValue: '重启前确认未保存改动',
        })
      case 'app-quit':
      default:
        return t('dirtyExitConfirm.title.appQuit', {
          defaultValue: '退出前确认未保存改动',
        })
    }
  }, [reason, t])

  const messageText = useMemo(() => {
    const count = resources.length
    if (reason === 'space-delete') {
      return t('dirtyExitConfirm.message.spaceDelete', {
        defaultValue: '即将删除的工作空间 "{{name}}" 中有 {{count}} 个文档尚未保存。删除后无法恢复。',
        name: spaceName ?? '',
        count,
      })
    }
    if (reason === 'window-close') {
      return t('dirtyExitConfirm.message.windowClose', {
        defaultValue: '关闭窗口前发现 {{count}} 个文档尚未保存。',
        count,
      })
    }
    if (reason === 'app-relaunch') {
      // 突出"重启完成后会自动重新打开"——缓解用户对"是不是要 quit 我"的担心。
      return t('dirtyExitConfirm.message.appRelaunch', {
        defaultValue: '重启 TabTin 前发现 {{count}} 个文档尚未保存。重启完成后 TabTin 会自动重新打开。',
        count,
      })
    }
    return t('dirtyExitConfirm.message.appQuit', {
      defaultValue: '退出前发现 {{count}} 个文档尚未保存。',
      count,
    })
  }, [reason, resources.length, spaceName, t])

  // 取消按钮文案按 reason 区分（删除 / 关闭 / 退出 / 重启）
  const cancelText = useMemo(() => {
    if (reason === 'space-delete') {
      return t('dirtyExitConfirm.cancelDelete', { defaultValue: '取消删除' })
    }
    if (reason === 'window-close') {
      return t('dirtyExitConfirm.cancelClose', { defaultValue: '取消关闭' })
    }
    if (reason === 'app-relaunch') {
      return t('dirtyExitConfirm.cancelRelaunch', { defaultValue: '取消重启' })
    }
    return t('dirtyExitConfirm.cancelExit', { defaultValue: '取消退出' })
  }, [reason, t])

  // 主按钮文案：单文档显示"保存并继续"，多文档"全部保存并继续"
  const saveActionText = useMemo(() => {
    if (resources.length === 1) {
      return t('dirtyExitConfirm.saveOne', { defaultValue: '保存并继续' })
    }
    return t('dirtyExitConfirm.saveAll', { defaultValue: '全部保存并继续' })
  }, [resources.length, t])

  const handleCancel = useCallback(() => {
    if (isSaving) return
    settleDirtyExitConfirm('cancel')
  }, [isSaving])

  const handleDiscard = useCallback(() => {
    if (isSaving) return
    settleDirtyExitConfirm('discard')
  }, [isSaving])

  const handleSaveAll = useCallback(async () => {
    if (isSaving) return
    markDirtyExitConfirmSaving()

    // 串行保存，每一条更新进度。saveAllDirty 内部 catch 异常并 resolve(false)。
    const results = await saveAllDirty(resources, (done, total, current) => {
      setDirtyExitConfirmProgress({ done, total, currentTitle: current.title || '' })
    })

    // saving 完成后还原 progress 到 null，settle 时由 store 重置为 idle
    setDirtyExitConfirmProgress(null)
    settleDirtyExitConfirm('save-all', results)
  }, [isSaving, resources])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<FileText className="h-7 w-7" />}
          title={titleText}
          description={(
            <div className="space-y-2 pt-1">
              <p className="m-0 text-body text-muted-foreground/80">{messageText}</p>
              <p className="m-0 text-body text-muted-foreground/60">
                {t('dirtyExitConfirm.chooseHint', {
                  defaultValue: '"全部保存"会先尝试保存所有文档；"全部放弃"会丢失这些文档里所有还没保存的改动。',
                })}
              </p>
            </div>
          )}
        />

        {/* dirty 列表 —— 始终显示，让用户清楚哪些文档将被处理 */}
        <DirtyList resources={resources} highlightSaving={isSaving} progress={progress} />

        {isSaving && progress ? (
          <div className="space-y-1">
            <p className="text-body text-muted-foreground/80 m-0">
              {t('dirtyExitConfirm.savingProgress', {
                defaultValue: '正在保存 {{done}} / {{total}}：{{name}}',
                done: progress.done + 1,
                total: progress.total,
                name: progress.currentTitle || t('dirtyExitConfirm.untitled', { defaultValue: '未命名' }),
              })}
            </p>
            <p className="text-caption text-muted-foreground/60 m-0">
              {t('dirtyExitConfirm.savingNoCancelHint', {
                defaultValue: '保存进行中，请稍候（无法取消）',
              })}
            </p>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:space-x-2">
          <Button
            type="button"
            variant="outline"
            className="w-full text-body sm:w-auto"
            onClick={handleCancel}
            disabled={isSaving}
            autoFocus={!isSaving}
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full text-body sm:w-auto"
            onClick={handleDiscard}
            disabled={isSaving}
          >
            {t('dirtyExitConfirm.discardAll', { defaultValue: '全部放弃' })}
          </Button>
          <Button
            type="button"
            variant="default"
            className="w-full text-body sm:w-auto"
            onClick={handleSaveAll}
            disabled={isSaving}
          >
            {isSaving
              ? t('dirtyExitConfirm.saving', { defaultValue: '保存中…' })
              : saveActionText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface DirtyListProps {
  resources: readonly DirtyResource[]
  highlightSaving: boolean
  progress: { done: number; total: number; currentTitle: string } | null
}

function DirtyList({ resources, highlightSaving, progress }: DirtyListProps): React.ReactElement {
  const { t } = useTranslation('context')
  const untitled = t('dirtyExitConfirm.untitled', { defaultValue: '未命名' })

  return (
    <div className="max-h-60 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <ul className="m-0 list-none space-y-1.5 p-0">
        {resources.map((resource, idx) => {
          const isCurrent = highlightSaving && progress && progress.done === idx
          const isDone = highlightSaving && progress && progress.done > idx
          return (
            <li
              key={`${resource.type}:${resource.id}`}
              className={`flex items-center gap-2 text-body ${
                isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground/80'
              } ${isDone ? 'opacity-60' : ''}`}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
              <span className="truncate">{resource.title || untitled}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
