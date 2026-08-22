/**
 * antd 风格 message API —— 全仓短暂反馈的唯一正典调用面。
 *
 * 用法：
 *   message.success('保存成功')
 *   message.error({ content: '失败', description: reason })
 *   const h = message.loading('处理中…'); h.update({ type: 'success', content: '完成' })
 *
 * Electron overlay / 本窗 Host 等细节由 transport 消化，调用方无需感知。
 */

import {
  defaultMessageController,
  type MessageActionModel,
  type MessageController,
  type MessageItem,
  type MessageType,
} from './message-controller'

export type MessageOpenOptions = {
  key?: string
  type?: MessageType
  content?: unknown
  description?: unknown
  /** ms；0 = 常驻。loading 默认常驻。 */
  duration?: number
  action?: MessageActionModel | unknown
}

export type MessageShorthandOptions = Omit<MessageOpenOptions, 'type' | 'content'>

export type MessageHandle = {
  key: string
  update: (patch: MessageOpenOptions) => MessageHandle
  destroy: () => void
  /** @deprecated 使用 destroy；兼容旧 toast().dismiss */
  dismiss: () => void
}

export type MessageTransportOpenInput = Omit<MessageItem, 'key' | 'open'> & {
  key?: string
  open?: boolean
}

export type MessageTransport = {
  open: (item: MessageTransportOpenInput) => MessageHandle
  update: (key: string, patch: MessageOpenOptions) => MessageHandle | null
  destroy: (key?: string) => void
}

function normalizeContentArg(
  contentOrOptions: unknown,
  options?: MessageShorthandOptions,
): MessageOpenOptions {
  if (
    contentOrOptions !== null &&
    typeof contentOrOptions === 'object' &&
    !Array.isArray(contentOrOptions) &&
    ('content' in (contentOrOptions as object) ||
      'description' in (contentOrOptions as object) ||
      'key' in (contentOrOptions as object) ||
      'duration' in (contentOrOptions as object) ||
      'action' in (contentOrOptions as object) ||
      'type' in (contentOrOptions as object))
  ) {
    return { ...(contentOrOptions as MessageOpenOptions), ...options }
  }
  return { ...options, content: contentOrOptions }
}

export function createLocalMessageTransport(
  controller: MessageController = defaultMessageController,
): MessageTransport {
  const makeHandle = (key: string): MessageHandle => ({
    key,
    update: (patch) => {
      const next = controller.update({
        key,
        type: patch.type,
        content: patch.content,
        description: patch.description,
        duration: patch.duration,
        action: patch.action,
      })
      return makeHandle(next?.key ?? key)
    },
    destroy: () => {
      controller.destroy(key)
    },
    dismiss: () => {
      controller.destroy(key)
    },
  })

  return {
    open: (item) => {
      const opened = controller.open(item)
      return makeHandle(opened.key)
    },
    update: (key, patch) => {
      const next = controller.update({
        key,
        type: patch.type,
        content: patch.content,
        description: patch.description,
        duration: patch.duration,
        action: patch.action,
      })
      return next ? makeHandle(next.key) : null
    },
    destroy: (key) => {
      controller.destroy(key)
    },
  }
}

let activeTransport: MessageTransport = createLocalMessageTransport(defaultMessageController)

/**
 * 宿主注入传输层（例如 Electron overlay）。
 * 未注入时默认写本窗 MessageController。
 */
export function installMessageTransport(transport: MessageTransport | null): void {
  activeTransport = transport ?? createLocalMessageTransport(defaultMessageController)
}

export function getMessageTransport(): MessageTransport {
  return activeTransport
}

export function getMessageController(): MessageController {
  return defaultMessageController
}

function openWithType(type: MessageType, contentOrOptions: unknown, options?: MessageShorthandOptions): MessageHandle {
  const normalized = normalizeContentArg(contentOrOptions, options)
  return activeTransport.open({
    key: normalized.key,
    type: normalized.type ?? type,
    content: normalized.content,
    description: normalized.description,
    duration: normalized.duration,
    action: normalized.action,
    open: true,
  })
}

function open(options: MessageOpenOptions): MessageHandle {
  const type = options.type ?? 'info'
  return openWithType(type, options)
}

function destroy(key?: string): void {
  activeTransport.destroy(key)
}

export type MessagePromiseMessages<T> = {
  loading: unknown
  success: unknown | ((value: T) => unknown)
  error: unknown | ((error: unknown) => unknown)
}

export interface MessageApi {
  (content: unknown, options?: MessageShorthandOptions): MessageHandle
  open: (options: MessageOpenOptions) => MessageHandle
  destroy: (key?: string) => void
  info: (content: unknown, options?: MessageShorthandOptions) => MessageHandle
  success: (content: unknown, options?: MessageShorthandOptions) => MessageHandle
  error: (content: unknown, options?: MessageShorthandOptions) => MessageHandle
  warning: (content: unknown, options?: MessageShorthandOptions) => MessageHandle
  loading: (content: unknown, options?: MessageShorthandOptions) => MessageHandle
  promise: <T>(
    input: Promise<T> | (() => Promise<T>),
    msgs: MessagePromiseMessages<T>,
  ) => Promise<T>
}

async function runPromise<T>(
  input: Promise<T> | (() => Promise<T>),
  msgs: MessagePromiseMessages<T>,
): Promise<T> {
  const handle = openWithType('loading', msgs.loading, { duration: 0 })
  try {
    const value = await (typeof input === 'function' ? input() : input)
    const successContent =
      typeof msgs.success === 'function' ? msgs.success(value) : msgs.success
    handle.update({ type: 'success', content: successContent })
    return value
  } catch (error) {
    const errorContent =
      typeof msgs.error === 'function' ? msgs.error(error) : msgs.error
    handle.update({ type: 'error', content: errorContent })
    throw error
  }
}

export const message: MessageApi = Object.assign(
  (content: unknown, options?: MessageShorthandOptions) =>
    openWithType('info', content, options),
  {
    open,
    destroy,
    info: (content: unknown, options?: MessageShorthandOptions) =>
      openWithType('info', content, options),
    success: (content: unknown, options?: MessageShorthandOptions) =>
      openWithType('success', content, options),
    error: (content: unknown, options?: MessageShorthandOptions) =>
      openWithType('error', content, options),
    warning: (content: unknown, options?: MessageShorthandOptions) =>
      openWithType('warning', content, options),
    loading: (content: unknown, options?: MessageShorthandOptions) =>
      openWithType('loading', content, { duration: 0, ...options }),
    promise: runPromise,
  },
)
