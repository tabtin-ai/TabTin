/**
 * @deprecated 请改用 `import { message } from '@tabtin/smartsheet-ui/message'`。
 * 本文件保留 toast() / useToast() 兼容壳，内部全部转发到统一 MessageController。
 */

import * as React from 'react'
import type { ToastActionElement, ToastProps, ToastVariant } from './toast'
import {
  defaultMessageController,
  type MessageItem,
  type MessageType,
} from './message-controller'
import { message, type MessageHandle } from './message-api'

// Omit HTMLAttributes.title（DOM string）——toast 的 title 是 ReactNode 主文案。
type ToasterToast = Omit<ToastProps, 'title'> & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}

function variantToType(variant?: ToastVariant): MessageType {
  if (variant === 'destructive') return 'error'
  if (variant === 'success') return 'success'
  if (variant === 'warning') return 'warning'
  return 'info'
}

function typeToVariant(type: MessageType): ToastVariant {
  if (type === 'error') return 'destructive'
  if (type === 'success') return 'success'
  if (type === 'warning') return 'warning'
  return 'default'
}

function normalizeDuration(duration: number | undefined): number | undefined {
  if (duration === undefined) return undefined
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return duration
}

function toToastView(item: MessageItem): ToasterToast {
  return {
    id: item.key,
    title: item.content as React.ReactNode,
    description: item.description as React.ReactNode,
    action: item.action as ToastActionElement | undefined,
    variant: typeToVariant(item.type),
    duration: item.duration,
    open: item.open,
  }
}

type Toast = Omit<ToasterToast, 'id'> & { id?: string }

type ToastReturnType = { id: string; dismiss: () => void; update: (props: ToasterToast) => void }
type ToastShorthand = (
  description: React.ReactNode,
  opts?: Omit<Partial<Toast>, 'variant'> & { preferNative?: boolean },
) => ToastReturnType

export interface ToastFn {
  (props: Toast & { preferNative?: boolean }): ToastReturnType
  success: ToastShorthand
  error: ToastShorthand
  info: ToastShorthand
  warning: ToastShorthand
}

function handleFromMessage(handle: MessageHandle): ToastReturnType {
  return {
    id: handle.key,
    dismiss: () => handle.destroy(),
    update: (props: ToasterToast) => {
      handle.update({
        key: handle.key,
        type: variantToType(props.variant),
        content: props.title,
        description: props.description,
        duration: normalizeDuration(props.duration),
        action: props.action,
      })
    },
  }
}

function _toast({ id: explicitId, preferNative: _preferNative, ...props }: Toast & { preferNative?: boolean }) {
  const handle = message.open({
    key: explicitId,
    type: variantToType(props.variant),
    content: props.title,
    description: props.description,
    duration: normalizeDuration(props.duration),
    action: props.action,
  })
  return handleFromMessage(handle)
}

function createShorthand(variant: ToastVariant) {
  return (
    description: React.ReactNode,
    opts?: Omit<Partial<Toast>, 'variant'> & { preferNative?: boolean },
  ) =>
    // 主文案进 content（title 位），与 message.success('x') / overlay title 对齐
    _toast({
      ...opts,
      variant,
      title: description,
      description: opts?.description,
    })
}

const toast = Object.assign(_toast, {
  success: createShorthand('success'),
  error: createShorthand('destructive'),
  info: createShorthand('default'),
  warning: createShorthand('warning'),
}) as ToastFn

function useToast() {
  const [toasts, setToasts] = React.useState<ToasterToast[]>(() =>
    defaultMessageController.getVisibleItems().map(toToastView),
  )

  React.useEffect(() => {
    return defaultMessageController.subscribe((items) => {
      setToasts(items.filter((item) => item.open !== false).map(toToastView))
    })
  }, [])

  return {
    toasts,
    toast,
    dismiss: (toastId?: string) => {
      message.destroy(toastId)
    },
  }
}

/** 兼容旧 reducer 测试：保留最小导出形状 */
export const reducer = (
  state: { toasts: ToasterToast[] },
  action: { type: string; toast?: Partial<ToasterToast>; toastId?: string },
): { toasts: ToasterToast[] } => {
  if (action.type === 'ADD_TOAST' && action.toast?.id) {
    const next = toToastView(
      defaultMessageController.open({
        key: action.toast.id,
        type: variantToType(action.toast.variant),
        content: action.toast.title,
        description: action.toast.description,
        duration: normalizeDuration(action.toast.duration),
        action: action.toast.action,
      }),
    )
    return { toasts: [next, ...state.toasts.filter((t) => t.id !== next.id)].slice(0, 5) }
  }
  if (action.type === 'DISMISS_TOAST') {
    message.destroy(action.toastId)
    return {
      toasts: state.toasts.map((t) =>
        t.id === action.toastId || action.toastId === undefined ? { ...t, open: false } : t,
      ),
    }
  }
  if (action.type === 'REMOVE_TOAST') {
    return {
      toasts:
        action.toastId === undefined
          ? []
          : state.toasts.filter((t) => t.id !== action.toastId),
    }
  }
  if (action.type === 'UPDATE_TOAST' && action.toast?.id) {
    defaultMessageController.update({
      key: action.toast.id,
      type: action.toast.variant ? variantToType(action.toast.variant) : undefined,
      content: action.toast.title,
      description: action.toast.description,
      duration: normalizeDuration(action.toast.duration),
      action: action.toast.action,
    })
    return {
      toasts: state.toasts.map((t) =>
        t.id === action.toast?.id ? { ...t, ...action.toast } : t,
      ),
    }
  }
  return state
}

export { useToast, toast }
