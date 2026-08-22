/**
 * RemovedFromResourceOverlay — F6 编辑器全屏无权限遮罩
 *
 * 触发场景(PRD §五块 2.3 末段):
 *  - resource_shared 通知 action='removed'(被显式移除)
 *  - resource_shared 通知 action='auto_removed'(因离开组织级联失活)
 *
 * 遮罩**不可关闭**(用户必须主动"返回空间"),避免误以为只是 toast 一闪而过。
 * "返回空间"按钮由调用方注入(各端导航 API 不同)。
 */
import React from 'react'
import { Lock } from 'lucide-react'
import { Button } from '../components/button'

export interface RemovedFromResourceOverlayProps {
  /** 资源标题,显示在文案"您没有《xxx》的权限"中 */
  resourceTitle: string
  /** 'removed' = 人工移除；'auto_removed' = 离队级联；'unavailable' = 资源已失效。 */
  action: 'removed' | 'auto_removed' | 'unavailable'
  /** 点击"返回空间"按钮的回调 */
  onReturn?: () => void
  /** 资源仍存在但权限不足时，快速申请查看。资源失效时不要传入。 */
  onRequestView?: () => void
  /** 资源仍存在但权限不足时，快速申请编辑。资源失效时不要传入。 */
  onRequestEdit?: () => void
  /** 当前正在提交的申请；提交期间防止重复点击。 */
  requestingRole?: 'viewer' | 'editor' | null
  /** 已提交的最高权限申请；editor 同时覆盖 viewer。 */
  requestedRole?: 'viewer' | 'editor' | null
  /**
   * 调用方传入的 t 函数(react-i18next 的 useTranslation('common').t)。
   * 缺省时用 fallback 中文文案。share.editor.removed.* keys 由 Wave 4 §宪法清单 D 注册。
   */
  t?: (key: string, opts?: Record<string, unknown>) => string
}

export const RemovedFromResourceOverlay: React.FC<RemovedFromResourceOverlayProps> = ({
  resourceTitle,
  action,
  onReturn,
  onRequestView,
  onRequestEdit,
  requestingRole = null,
  requestedRole = null,
  t,
}) => {
  const tt = t ?? ((_k: string, opts?: Record<string, unknown>) => (opts?.defaultValue ?? _k) as string)

  // 权限被收回与资源失效共用同一套恢复页骨架，但文案和可执行动作必须区分。
  const title =
    action === 'unavailable'
      ? resourceTitle
        ? tt('share.editor.removed.titleUnavailable', {
            title: resourceTitle,
            defaultValue: `《${resourceTitle}》已失效`,
          })
        : tt('share.editor.removed.titleUnavailableGeneric', {
            defaultValue: '资源已失效',
          })
      : action === 'auto_removed'
      ? tt('share.editor.removed.titleAuto', {
          title: resourceTitle,
          defaultValue: `因离开组织,你已无法访问《${resourceTitle}》`,
        })
      : tt('share.editor.removed.title', {
          title: resourceTitle,
          defaultValue: `您没有《${resourceTitle}》的权限`,
        })

  const cta = tt('share.editor.removed.cta', { defaultValue: '返回空间' })
  const hint = action === 'unavailable'
    ? tt('share.editor.removed.hintUnavailable', {
        defaultValue: '该资源不存在、已删除或不再可用。',
      })
    : tt('share.editor.removed.hint', {
        defaultValue: '你最近的编辑已保留在本地,但不再上传到服务器。',
      })
  const requestView = tt('share.editor.removed.requestView', { defaultValue: '申请查看' })
  const requestEdit = tt('share.editor.removed.requestEdit', { defaultValue: '申请编辑' })
  const requesting = tt('share.editor.removed.requesting', { defaultValue: '申请中…' })
  const viewRequested = tt('share.editor.removed.viewRequested', { defaultValue: '已申请查看' })
  const editRequested = tt('share.editor.removed.editRequested', { defaultValue: '已申请编辑' })
  const isRequesting = requestingRole !== null
  const hasRequestedView = requestedRole === 'viewer' || requestedRole === 'editor'
  const hasRequestedEdit = requestedRole === 'editor'

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      data-testid="resource-removed-overlay"
    >
      <div className="max-w-md flex flex-col items-center gap-4 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <Lock className="h-7 w-7 text-destructive" />
        </div>
        <div className="text-h3 font-semibold text-foreground">{title}</div>
        <div className="text-body text-muted-foreground">{hint}</div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onReturn && <Button onClick={onReturn}>{cta}</Button>}
          {onRequestView && (
            <Button
              variant="outline"
              onClick={onRequestView}
              disabled={isRequesting || hasRequestedView}
            >
              {requestingRole === 'viewer' ? requesting : hasRequestedView ? viewRequested : requestView}
            </Button>
          )}
          {onRequestEdit && (
            <Button
              variant="outline"
              onClick={onRequestEdit}
              disabled={isRequesting || hasRequestedEdit}
            >
              {requestingRole === 'editor' ? requesting : hasRequestedEdit ? editRequested : requestEdit}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
