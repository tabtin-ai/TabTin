/**
 * ClearConfirmDialog — 4 档 Affordance 的对话框组件（D-4 严格实施）。
 *
 * 档位行为：
 *   - L1（cache + none）：不渲染对话框，调用方直接调 onClear；本组件不处理 L1
 *     —— 即使 props.descriptor 是 L1，open=true 时也只渲染一个空 Dialog 并
 *     立刻调 onClear + 关闭，作为兜底。但调用方 BucketCard 不会让 L1 走对话框。
 *   - L2（semi-cache + soft）：单按钮 + 副标题"清后下次首次加载会变慢"
 *   - L3-soft（data + soft）：warnings 列表 + 输入 displayName 才能确认
 *   - L3-hard（data + hard，非 login/system 组）：L3-soft + "我已了解后果" checkbox
 *   - L4（data + hard + group ∈ {login, system}）：L3-hard + 进度条（清理过程中）+ 红色警告样式
 *
 * 输入校验：必须**精确匹配** displayName（trim 后），不区分大小写——避免
 * 用户因为大小写差异多按几次还过不了，也避免太宽松（比如 substring）让
 * 用户随便输几个字就过。
 *
 * 严格遵守 design-system.md：
 *   - text-subtitle 用于对话框标题
 *   - text-body 用于按钮 / 输入框 / 段落
 *   - text-caption 用于副标题 / 提示
 *   - 不用 z-[9999]，对话框默认 z-modal
 *   - 透明度 /60 /80
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Progress,
} from '@tabtin/smartsheet-ui'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL } from '@components/settings/settingsUi'
import {
  formatBytes,
  resolveAffordanceLevel,
  type BucketDescriptor,
  type BucketSizeReport,
  type ClearHandler,
} from './types'

interface ClearConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  descriptor: BucketDescriptor
  size?: BucketSizeReport
  onClear: ClearHandler
  /** 清理成功通知容器刷新 size，可选 */
  onCleared?: () => void
  /**
   * ：名称确认旁是否显示「填充」。
   * 默认 true（存储状态凡需输入名称的清理框都展示）；传 false 可关闭。
   */
  showNameFill?: boolean
}

export const ClearConfirmDialog: React.FC<ClearConfirmDialogProps> = ({
  open,
  onOpenChange,
  descriptor,
  size,
  onClear,
  onCleared,
  showNameFill = true,
}) => {
  const { t } = useTranslation('storage-manager')
  const level = useMemo(() => resolveAffordanceLevel(descriptor), [descriptor])

  const [nameInput, setNameInput] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  // 每次打开重置状态——避免上次的输入残留导致"我没输入怎么按钮就亮了"
  useEffect(() => {
    if (open) {
      setNameInput('')
      setAcknowledged(false)
      setError(null)
      setProgress(0)
      setBusy(false)
      setPartialErrors(null)
    }
  }, [open])

  // L1 兜底：理论上不应进对话框，万一进了立刻调 onClear 关闭
  useEffect(() => {
    if (open && level === 'L1' && !busy) {
      void (async () => {
        setBusy(true)
        try {
          await onClear(descriptor.id)
          onCleared?.()
        } finally {
          setBusy(false)
          onOpenChange(false)
        }
      })()
    }
  }, [open, level, busy, descriptor.id, onClear, onCleared, onOpenChange])

  // 输入是否匹配 displayName（trim 后大小写无关）
  const nameMatches =
    nameInput.trim().toLowerCase() ===
    descriptor.displayName.trim().toLowerCase()

  // 各档"确认按钮可用条件"
  const confirmEnabled = (() => {
    if (busy) return false
    switch (level) {
      case 'L1':
      case 'L2':
        return true
      case 'L3-soft':
        return nameMatches
      case 'L3-hard':
      case 'L4':
        return nameMatches && acknowledged
    }
  })()

  // 部分失败的错误清单（R2 must-fix：不能静默吞）
  const [partialErrors, setPartialErrors] = useState<string[] | null>(null)

  const handleConfirm = async () => {
    if (!confirmEnabled) return
    setBusy(true)
    setError(null)
    setPartialErrors(null)
    try {
      // L4 显示进度条 — v1 用 indeterminate-ish 模拟（实际清理是单次 IPC，
      // 没法精细到每条进度），但视觉上"动起来 + 看到 100%"对误删恐惧用户
      // 是必要的安抚。
      let progressTimer: ReturnType<typeof setInterval> | null = null
      if (level === 'L4') {
        let pct = 0
        progressTimer = setInterval(() => {
          pct = Math.min(pct + 8, 90)
          setProgress(pct)
        }, 120)
      }
      try {
        const result = await onClear(descriptor.id)
        if (progressTimer) {
          clearInterval(progressTimer)
          progressTimer = null
        }
        setProgress(100)
        // R2 must-fix M5：result.errors 非空 → **不能关闭对话框**，把错误列表
        // 展示给用户看，让用户显式 Acknowledge。否则 wipe-all 部分失败时
        // 用户以为全清成功，实则大半还在。
        if (result?.errors && result.errors.length > 0) {
          setPartialErrors(result.errors)
          setBusy(false)
          return
        }
        onCleared?.()
        // 给用户看一眼 100% 再关
        if (level === 'L4') {
          await new Promise((r) => setTimeout(r, 250))
        }
        onOpenChange(false)
      } finally {
        if (progressTimer) clearInterval(progressTimer)
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('errors.clearFailed', { defaultValue: '清理失败' }),
      )
    } finally {
      setBusy(false)
    }
  }

  if (level === 'L1') {
    // L1 不渲染 UI（兜底 useEffect 已处理）
    return null
  }

  // 文案 + 视觉切换
  const isDestructive = level === 'L3-soft' || level === 'L3-hard' || level === 'L4'
  const isExtreme = level === 'L4'

  // busy 期间允许用户通过 Esc / 点外部关闭——底层 IPC 卡死时给一条
  // 逃生路径，避免对话框完全锁死（R2 S7）。底层 clearFn 仍会跑完，
  // 只是 UI 层不再拦截。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'sm:max-w-md',
          isExtreme && 'border-destructive/60',
        )}
        data-testid={`clear-confirm-dialog-${level}`}
      >
        <DialogHeader>
          <DialogTitle
            className={cn(
              'text-subtitle font-medium flex items-center gap-2',
              isDestructive && 'text-destructive',
            )}
          >
            {isExtreme ? (
              <ShieldAlert className="h-4 w-4 shrink-0" />
            ) : isDestructive ? (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            ) : null}
            {t(`dialog.${level}.title`, {
              name: descriptor.displayName,
              defaultValue: '清理 {{name}}',
            })}
          </DialogTitle>
          <DialogDescription className="text-body text-muted-foreground/80">
            {/*
              文案优先级：
                - L2 → 固定模板"清后下次首次加载会变慢"（cache 类语义稳定）
                - 其他 → 优先用 bucket.description（业务模块自己定义的"一句话用户级说明"，
                  最贴合实际清理范围；高级动作 wipe-all / reset-device / logout 的
                  description 由 AdvancedTab 显式注入，不会复用 L4 的通用模板，避免
                  "清空所有数据"看到"涉及账号 / 设备身份"这种缩水提示）
                - bucket.description 为空时才退回 dialog.${level}.subtitle 模板
            */}
            {level === 'L2'
              ? t('dialog.L2.subtitle', {
                  defaultValue: '清后下次首次加载会变慢，但不会丢任何资产。',
                })
              : descriptor.description?.trim()
                ? descriptor.description
                : t(`dialog.${level}.subtitle`, {
                    defaultValue: descriptor.description ?? '',
                  })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 容量预览 */}
          {size && (
            <div className="rounded-md bg-muted/40 px-3 py-2 flex items-center justify-between text-body">
              <span className="text-muted-foreground/80">
                {t('dialog.willFree', { defaultValue: '将释放' })}
              </span>
              <span className="font-medium tabular-nums">
                {formatBytes(size.bytes)}
                {typeof size.itemCount === 'number' && (
                  <span className="ml-2 text-caption text-muted-foreground/60">
                    {t('itemCount', {
                      count: size.itemCount,
                      defaultValue: '{{count}} 项',
                    })}
                  </span>
                )}
              </span>
            </div>
          )}

          {/* warnings 列表（L3 / L4 必填）—— modal 内允许低饱和警示色，
              但避免 destructive/5 + destructive/30 的"边框 + 浅底"叠加，
              改为单一 destructive/10 surface tint。 */}
          {isDestructive && descriptor.warnings && descriptor.warnings.length > 0 && (
            <div className="rounded-md bg-destructive/10 p-3">
              <div className="text-body font-medium text-destructive mb-1.5">
                {t('dialog.warningsTitle', { defaultValue: '清后会丢失：' })}
              </div>
              <ul className="space-y-1 text-body text-foreground/80 list-disc pl-5">
                {descriptor.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* L3 / L4：输入 displayName 确认 */}
          {(level === 'L3-soft' || level === 'L3-hard' || level === 'L4') && (
            <div className="space-y-1.5">
              <label
                htmlFor={`bucket-name-input-${descriptor.id}`}
                className="text-body font-medium text-muted-foreground"
              >
                {t('dialog.typeNameLabel', {
                  name: descriptor.displayName,
                  defaultValue: '请输入「{{name}}」以确认',
                })}
              </label>
              {showNameFill ? (
                // Input 内部自带 w-full 包装层，必须再包一层 flex-1，否则会把右侧「填充」挤掉
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      id={`bucket-name-input-${descriptor.id}`}
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      placeholder={descriptor.displayName}
                      className={SETTINGS_CONTROL}
                      disabled={busy}
                      data-testid="clear-confirm-name-input"
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setNameInput(descriptor.displayName)}
                    data-testid="clear-confirm-fill-name"
                    className="h-8 shrink-0 px-3"
                  >
                    {t('dialog.fillName', { defaultValue: '填充' })}
                  </Button>
                </div>
              ) : (
                <Input
                  id={`bucket-name-input-${descriptor.id}`}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder={descriptor.displayName}
                  className={SETTINGS_CONTROL}
                  disabled={busy}
                  data-testid="clear-confirm-name-input"
                  autoComplete="off"
                />
              )}
            </div>
          )}

          {/* L3-hard / L4：勾选 checkbox */}
          {(level === 'L3-hard' || level === 'L4') && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                disabled={busy}
                data-testid="clear-confirm-acknowledge"
                className="mt-0.5"
              />
              <span className="text-body text-foreground/80">
                {t('dialog.acknowledgeLabel', {
                  defaultValue: '我已了解清理后果，且无法恢复',
                })}
              </span>
            </label>
          )}

          {/* L4：进度条（清理中可见） */}
          {level === 'L4' && busy && (
            <div className="space-y-1.5">
              <Progress value={progress} className="h-1.5" />
              <div className="text-caption text-muted-foreground/60 tabular-nums">
                {progress}%
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-body text-destructive flex items-start gap-2"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* 部分失败列表（R2 must-fix：不能静默吞） */}
          {partialErrors && partialErrors.length > 0 && (
            <div
              role="alert"
              data-testid="clear-confirm-partial-errors"
              className="rounded-md bg-warning/10 p-3"
            >
              <div className="flex items-start gap-2 mb-1.5">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <span className="text-body font-medium text-warning">
                  {t('dialog.partialFailureTitle', {
                    count: partialErrors.length,
                    defaultValue: '部分清理失败（{{count}} 项）',
                  })}
                </span>
              </div>
              <ul className="text-body text-foreground/80 list-disc pl-6 space-y-1 max-h-32 overflow-y-auto">
                {partialErrors.map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
              <p className="mt-2 text-caption text-muted-foreground/80">
                {t('dialog.partialFailureHint', {
                  defaultValue:
                    '部分项目未被清理（可能因为正在使用 / 权限不足）。点"我已了解"关闭，稍后可单独重试。',
                })}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel', { defaultValue: '取消' })}
          </Button>
          {partialErrors && partialErrors.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="clear-confirm-acknowledge-partial"
            >
              {t('actions.acknowledgePartial', {
                defaultValue: '我已了解',
              })}
            </Button>
          ) : (
            <Button
              variant={isDestructive ? 'destructive' : 'default'}
              size="sm"
              disabled={!confirmEnabled}
              onClick={handleConfirm}
              data-testid="clear-confirm-confirm"
            >
              {busy
                ? t('actions.clearing', { defaultValue: '清理中…' })
                : level === 'L2'
                  ? t('actions.confirmClear', { defaultValue: '确认清理' })
                  : t('actions.confirmDestroy', { defaultValue: '确认删除' })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
