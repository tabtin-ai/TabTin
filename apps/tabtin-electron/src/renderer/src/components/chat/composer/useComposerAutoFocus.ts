import { useEffect, type RefObject } from 'react'

/**
 * 判断把焦点拉回 composer textarea 是否会抢用户正在操作的控件。
 * body / 文档根 / 已是本 textarea → 安全；其他输入框、可编辑区、对话框 / 菜单 → 不抢。
 */
export function canSafelyFocusComposer(textarea: HTMLTextAreaElement): boolean {
  const active = document.activeElement
  if (!active || active === document.body || active === document.documentElement) {
    return true
  }
  if (active === textarea) return true
  if (!(active instanceof HTMLElement)) return true

  const tag = active.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) {
    return false
  }
  // 含模型选择器浮层（目前无 listbox/menu role）与 Radix popper
  if (
    active.closest(
      '[role="dialog"], [role="listbox"], [role="menu"], [role="combobox"], [data-testid="compact-model-selector-menu"], [data-radix-popper-content-wrapper]',
    )
  ) {
    return false
  }
  return true
}

/** 对齐 IM / deliverContextInject 的 rAF focus，避免 remount / disabled 翻转当帧抢不到。 */
export function focusComposerTextareaSoon(
  textarea: HTMLTextAreaElement | null | undefined,
): void {
  if (!textarea || typeof window === 'undefined') return
  if (typeof window.requestAnimationFrame !== 'function') {
    if (!textarea.disabled && canSafelyFocusComposer(textarea)) {
      textarea.focus({ preventScroll: true })
    }
    return
  }
  window.requestAnimationFrame(() => {
    if (textarea.disabled) return
    if (!canSafelyFocusComposer(textarea)) return
    textarea.focus({ preventScroll: true })
  })
}

export interface UseComposerAutoFocusParams {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** 切会话 / 草稿→正式 remount 的 scope key */
  draftKey: string | null
  sessionId: string | null | undefined
  /** 含 isSendInFlight / restore 等；disabled 时浏览器无法 focus */
  disabled: boolean
  /** 分屏非活跃 pane 为 false，避免抢活跃侧焦点 */
  acceptGlobalInputEvents?: boolean
}

/**
 * 进入对话、切会话、发送期 disabled 解除后，自动 focus 输入框。
 */
export function useComposerAutoFocus(params: UseComposerAutoFocusParams): void {
  const {
    textareaRef,
    draftKey,
    sessionId,
    disabled,
    acceptGlobalInputEvents = true,
  } = params

  useEffect(() => {
    if (!acceptGlobalInputEvents || disabled) return
    focusComposerTextareaSoon(textareaRef.current)
  }, [acceptGlobalInputEvents, disabled, draftKey, sessionId, textareaRef])
}
