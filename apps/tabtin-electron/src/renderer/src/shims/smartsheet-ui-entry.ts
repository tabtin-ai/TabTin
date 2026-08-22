/**
 * Electron renderer 对 `@tabtin/smartsheet-ui` 包根的解析入口。
 *
 * 打包后包根会走 `dist/index.js`，而 `@tabtin/smartsheet-ui/toast` 经 alias 落到
 * 本目录 shim → `toast-native`（源码）。两份 `use-toast` 内存态互不相通，导致
 * `toast()` 已调用但 `<Toaster />` / overlay 都看不到。
 *
 * 这里把包根的 toast 表面钉到 overlay-aware shim，让
 * `import { toast } from '@tabtin/smartsheet-ui'` 与
 * `import { toast } from '@components/ui'` 与 App 的 Toaster 共用同一条链路。
 *
 * `@ts-nocheck`：`export *` 与具名 `toast` 再导出在 tsc 下会报 TS2308；
 * Rollup/Vite 以具名导出为准，运行时正确。
 */
// @ts-nocheck

export * from '@tabtin/smartsheet-ui-core'

export {
  toast,
  useToast,
  Toaster,
  MessageHost,
  message,
  installMessageTransport,
  getMessageController,
} from '@tabtin/smartsheet-ui/toast'
export type {
  ToastFn,
  ToastProps,
  ToastActionElement,
  ToastVariant,
  ToastActionProps,
  MessageApi,
  MessageHandle,
  MessageOpenOptions,
  MessageTransport,
  MessageType,
  MessageItem,
  MessageActionModel,
} from '@tabtin/smartsheet-ui/toast'
