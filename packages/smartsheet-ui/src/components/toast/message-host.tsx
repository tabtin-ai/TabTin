import React, { useEffect, useState } from 'react'

import { t } from '../../i18n'
import { OVERLAY_SURFACE_CLASS, OPAQUE_OVERLAY_SURFACE_CLASS } from '../overlay-surface'
import {
  defaultMessageController,
  type MessageActionModel,
  type MessageItem,
  type MessageType,
} from './message-controller'
import { toastVariants, type ToastVariant } from './toast'

const viewportStyle: React.CSSProperties = {
  left: 'var(--tabtin-toast-viewport-center-x, 50%)',
  width: 'min(var(--tabtin-toast-viewport-width, 100vw), 100vw)',
}

const typeToVariant: Record<MessageType, ToastVariant> = {
  info: 'default',
  success: 'success',
  error: 'destructive',
  warning: 'warning',
  loading: 'default',
}

function isActionModel(value: unknown): value is MessageActionModel {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as MessageActionModel).label === 'string' &&
    typeof (value as MessageActionModel).onClick === 'function'
  )
}

function renderNode(value: unknown): React.ReactNode {
  if (value == null || value === false) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (React.isValidElement(value)) return value
  return null
}

/** CTA 点击后关闭当前 toast（设置跳转 / 重试等，避免浮层残留） */
function dismissAfterAction(toastKey: string, action?: () => void): void {
  try {
    action?.()
  } finally {
    defaultMessageController.destroy(toastKey)
  }
}

function wrapLegacyAction(action: React.ReactNode, toastKey: string): React.ReactNode {
  if (!React.isValidElement(action)) return action
  type ActionProps = {
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  }
  const element = action as React.ReactElement<ActionProps>
  const prevOnClick = element.props.onClick
  return React.cloneElement(element, {
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      dismissAfterAction(toastKey, () => prevOnClick?.(event))
    },
  })
}

export type MessageHostProps = {
  /**
   * overlay 子窗口使用不透明 surface，并给卡片打 `data-overlay-track`
   * 以便命中区取消鼠标穿透。
   */
  overlay?: boolean
  className?: string
}

export function MessageHost({ overlay = false, className }: MessageHostProps) {
  const [items, setItems] = useState<MessageItem[]>(() =>
    defaultMessageController.getVisibleItems(),
  )

  useEffect(() => {
    return defaultMessageController.subscribe((next) => {
      setItems(next.filter((item) => item.open !== false))
    })
  }, [])

  if (items.length === 0) return null

  const surfaceClass = overlay ? OPAQUE_OVERLAY_SURFACE_CLASS : OVERLAY_SURFACE_CLASS

  return (
    <div
      data-overlay-toast-viewport={overlay ? 'true' : undefined}
      // Electron 顶栏 WindowDragRegion 使用 -webkit-app-region: drag；
      // z-index 挡不住原生拖拽命中，交互浮层必须显式 no-drag。
      className={`app-region-no-drag pointer-events-none fixed top-0 z-toast-host flex w-full max-w-[420px] -translate-x-1/2 flex-col gap-2 p-4 ${className ?? ''}`}
      style={viewportStyle}
    >
      {items.map((item) => {
        const variant = typeToVariant[item.type] ?? 'default'
        const variantClass = toastVariants[variant] ?? toastVariants.default
        const content = renderNode(item.content)
        const description = renderNode(item.description)
        const actionModel = isActionModel(item.action) ? item.action : null
        const legacyAction =
          !actionModel && item.action != null ? (item.action as React.ReactNode) : null

        const hasAction = Boolean(actionModel || legacyAction)

        return (
          <div
            key={item.key}
            role="status"
            aria-live="polite"
            data-overlay-track={overlay ? 'true' : undefined}
            // 文案独占主列；关闭钮右上角；CTA 右下角，避免「去升级」挤进标题行
            className={`app-region-no-drag pointer-events-auto relative flex w-full flex-col gap-2 overflow-hidden rounded-interactive ${overlay ? 'border ' : ''}p-4 pr-10 ${surfaceClass} ${variantClass}`}
          >
            <button
              type="button"
              className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-interactive text-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
              onClick={() => defaultMessageController.destroy(item.key)}
              aria-label={t('toast.close')}
            >
              ×
            </button>
            <div className="grid min-w-0 gap-1">
              {content != null ? (
                <div className="text-body font-semibold leading-snug">{content}</div>
              ) : null}
              {description != null ? (
                <div className="break-all text-body opacity-90">{description}</div>
              ) : null}
            </div>
            {hasAction ? (
              <div className="flex justify-end">
                {actionModel ? (
                  <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-interactive border bg-transparent px-3 text-body font-medium transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => dismissAfterAction(item.key, actionModel.onClick)}
                    aria-label={actionModel.altText ?? actionModel.label}
                  >
                    {actionModel.label}
                  </button>
                ) : (
                  wrapLegacyAction(legacyAction, item.key)
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** @deprecated 使用 MessageHost；保留别名避免 Toaster 挂载点大爆炸 */
export const Toaster = MessageHost
