/**
 * Electron toast / message shim
 *
 * - 导出与 `@tabtin/smartsheet-ui/toast` / `/message` 相同的表面
 * - Message / toast **一律本窗 MessageHost**：无全屏透明子窗遮罩，关闭钮可点，到期自动消失
 * - 不再把纯文案桥到 overlay toast 子窗（该路径曾导致全局点不动 / × 点不掉，见 ）
 */

export {
  Toaster,
  MessageHost,
  Toast,
  ToastProvider,
  ToastViewport,
  ToastAction,
  ToastClose,
  ToastTitle,
  ToastDescription,
} from '@tabtin/smartsheet-ui/toast-native'
export type {
  ToastProps,
  ToastActionElement,
  ToastVariant,
  ToastActionProps,
  ToastFn,
  MessageApi,
  MessageHandle,
  MessageOpenOptions,
  MessageTransport,
  MessageType,
  MessageItem,
  MessageActionModel,
} from '@tabtin/smartsheet-ui/toast-native'

// toast-native 对齐 deprecated toast.ts，不含 message 公开时长常量；
// /message alias 也落到本 shim，须从 message-native 补齐表面（见 ）。
export {
  MESSAGE_LIMIT,
  MESSAGE_DEFAULT_DURATION,
  MESSAGE_ERROR_DURATION,
} from '@tabtin/smartsheet-ui/message-native'

import {
  toast as nativeToast,
  useToast,
  message as nativeMessage,
  installMessageTransport,
  getMessageController,
  type MessageOpenOptions,
  type ToastFn,
} from '@tabtin/smartsheet-ui/toast-native'

export { useToast, getMessageController }

/**
 * 历史兼容：曾注入 overlay transport。现为空操作——message 固定本窗 Host。
 */
export function reinstallElectronMessageTransport(): void {
  installMessageTransport(null)
}

/**
 * preferNative 兼容：本窗已是唯一路径，直接执行即可。
 */
function withPreferNative<T>(fn: () => T): T {
  return fn()
}

const toast = Object.assign(
  (props: Parameters<ToastFn>[0] & { preferNative?: boolean }) => {
    if (props.preferNative) {
      return withPreferNative(() => nativeToast(props))
    }
    return nativeToast(props)
  },
  {
    success: (
      description: Parameters<ToastFn['success']>[0],
      opts?: Parameters<ToastFn['success']>[1] & { preferNative?: boolean },
    ) => {
      if (opts?.preferNative) return withPreferNative(() => nativeToast.success(description, opts))
      return nativeToast.success(description, opts)
    },
    error: (
      description: Parameters<ToastFn['error']>[0],
      opts?: Parameters<ToastFn['error']>[1] & { preferNative?: boolean },
    ) => {
      if (opts?.preferNative) return withPreferNative(() => nativeToast.error(description, opts))
      return nativeToast.error(description, opts)
    },
    info: (
      description: Parameters<ToastFn['info']>[0],
      opts?: Parameters<ToastFn['info']>[1] & { preferNative?: boolean },
    ) => {
      if (opts?.preferNative) return withPreferNative(() => nativeToast.info(description, opts))
      return nativeToast.info(description, opts)
    },
    warning: (
      description: Parameters<ToastFn['warning']>[0],
      opts?: Parameters<ToastFn['warning']>[1] & { preferNative?: boolean },
    ) => {
      if (opts?.preferNative) return withPreferNative(() => nativeToast.warning(description, opts))
      return nativeToast.warning(description, opts)
    },
  },
) as ToastFn

export { toast }

export const message = Object.assign(
  (content: unknown, options?: MessageOpenOptions) => nativeMessage(content, options),
  {
    open: (options: MessageOpenOptions) => nativeMessage.open(options),
    destroy: (key?: string) => nativeMessage.destroy(key),
    info: (content: unknown, options?: MessageOpenOptions) =>
      nativeMessage.info(content, options),
    success: (content: unknown, options?: MessageOpenOptions) =>
      nativeMessage.success(content, options),
    error: (content: unknown, options?: MessageOpenOptions) =>
      nativeMessage.error(content, options),
    warning: (content: unknown, options?: MessageOpenOptions) =>
      nativeMessage.warning(content, options),
    loading: (content: unknown, options?: MessageOpenOptions) =>
      nativeMessage.loading(content, options),
    promise: <T,>(
      input: Promise<T> | (() => Promise<T>),
      msgs: {
        loading: unknown
        success: unknown | ((value: T) => unknown)
        error: unknown | ((error: unknown) => unknown)
      },
    ) => nativeMessage.promise(input, msgs),
  },
) as typeof nativeMessage

export { installMessageTransport }
