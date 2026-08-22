/**
 * @deprecated 请改用 `@tabtin/smartsheet-ui/message` 的 `message.*` / `MessageHost`。
 * 本入口保留兼容导出，内部已统一到 MessageController。
 */
export { Toaster, MessageHost } from './components/toast/toaster'
export { toast, useToast } from './components/toast/use-toast'
export {
  message,
  installMessageTransport,
  getMessageController,
  createLocalMessageTransport,
} from './components/toast/message-api'
export {
  Toast,
  ToastProvider,
  ToastViewport,
  ToastAction,
  ToastClose,
  ToastTitle,
  ToastDescription,
} from './components/toast/toast'
export type { ToastProps, ToastActionElement, ToastVariant, ToastActionProps } from './components/toast/toast'
export type { ToastFn } from './components/toast/use-toast'
export type { MessageApi, MessageHandle, MessageOpenOptions, MessageTransport } from './components/toast/message-api'
export type { MessageType, MessageItem, MessageActionModel } from './components/toast/message-controller'
