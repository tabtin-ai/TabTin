/**
 * Message 状态机（无 React 依赖）
 *
 * 统一短暂反馈的 key / duration / 堆叠 / destroy 语义。
 * 宿主渲染（MessageHost）与 Electron overlay transport 都挂在这套状态之上。
 */

export const MESSAGE_LIMIT = 5
export const MESSAGE_REMOVE_DELAY = 1_000_000
export const MESSAGE_DEFAULT_DURATION = 2_000
export const MESSAGE_ERROR_DURATION = 2_000

export type MessageType = 'info' | 'success' | 'error' | 'warning' | 'loading'

export type MessageActionModel = {
  label: string
  onClick: () => void
  altText?: string
}

export type MessageItem = {
  key: string
  type: MessageType
  content?: unknown
  description?: unknown
  /** ms；0 / Infinity / 非有限数 → 常驻，直到 update / destroy */
  duration?: number
  open: boolean
  action?: MessageActionModel | unknown
}

type Listener = (items: MessageItem[]) => void

let seq = 0

function nextKey(): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER
  return `msg-${seq}`
}

function defaultDurationForType(type: MessageType): number {
  if (type === 'loading') return 0
  if (type === 'error' || type === 'warning') return MESSAGE_ERROR_DURATION
  return MESSAGE_DEFAULT_DURATION
}

function resolveDuration(type: MessageType, duration: number | undefined): number {
  if (duration === undefined) return defaultDurationForType(type)
  if (!Number.isFinite(duration) || duration < 0) return 0
  return duration
}

function isSticky(duration: number): boolean {
  return !Number.isFinite(duration) || duration <= 0
}

export class MessageController {
  private items: MessageItem[] = []
  private listeners = new Set<Listener>()
  private dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private removeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.items)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getItems(): MessageItem[] {
    return this.items
  }

  getVisibleItems(): MessageItem[] {
    return this.items.filter((item) => item.open !== false)
  }

  open(input: Omit<MessageItem, 'open' | 'key'> & { key?: string }): MessageItem {
    const key = input.key?.trim() ? input.key : nextKey()
    const existing = this.items.find((item) => item.key === key && item.open !== false)
    const next: MessageItem = {
      key,
      type: input.type,
      content: input.content,
      description: input.description,
      duration: resolveDuration(input.type, input.duration),
      action: input.action,
      open: true,
    }

    if (existing) {
      this.items = this.items.map((item) => (item.key === key ? { ...item, ...next } : item))
    } else {
      this.items = [next, ...this.items.filter((item) => item.key !== key)].slice(0, MESSAGE_LIMIT)
    }

    this.scheduleAutoDestroy(key, next.type, next.duration)
    this.emit()
    return next
  }

  update(input: Partial<Omit<MessageItem, 'open'>> & { key: string }): MessageItem | null {
    const current = this.items.find((item) => item.key === input.key)
    if (!current || current.open === false) return null

    const type = input.type ?? current.type
    const typeChanged = input.type !== undefined && input.type !== current.type
    const duration =
      input.duration !== undefined
        ? resolveDuration(type, input.duration)
        : typeChanged
          ? defaultDurationForType(type)
          : current.duration ?? defaultDurationForType(type)

    const next: MessageItem = {
      ...current,
      ...input,
      type,
      duration,
      open: true,
    }

    this.items = this.items.map((item) => (item.key === input.key ? next : item))
    this.scheduleAutoDestroy(input.key, type, duration)
    this.emit()
    return next
  }

  destroy(key?: string): void {
    if (key === undefined) {
      const openKeys = this.items.filter((item) => item.open !== false).map((item) => item.key)
      if (openKeys.length === 0) return
      for (const openKey of openKeys) {
        this.clearDismissTimer(openKey)
        this.enqueueRemove(openKey)
      }
      this.items = this.items.map((item) => ({ ...item, open: false }))
      this.emit()
      return
    }

    const target = this.items.find((item) => item.key === key && item.open !== false)
    if (!target) return

    this.clearDismissTimer(key)
    this.enqueueRemove(key)
    this.items = this.items.map((item) =>
      item.key === key ? { ...item, open: false } : item,
    )
    this.emit()
  }

  /** 测试 / 热重载用：清空全部状态与定时器 */
  reset(): void {
    for (const timer of this.dismissTimers.values()) clearTimeout(timer)
    for (const timer of this.removeTimers.values()) clearTimeout(timer)
    this.dismissTimers.clear()
    this.removeTimers.clear()
    this.items = []
    this.emit()
  }

  private scheduleAutoDestroy(
    key: string,
    type: MessageType,
    duration: number | undefined,
  ): void {
    this.clearDismissTimer(key)
    const resolved = resolveDuration(type, duration)
    if (isSticky(resolved)) return

    const timer = setTimeout(() => {
      this.dismissTimers.delete(key)
      this.destroy(key)
    }, resolved)
    this.dismissTimers.set(key, timer)
  }

  private clearDismissTimer(key: string): void {
    const timer = this.dismissTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.dismissTimers.delete(key)
    }
  }

  private enqueueRemove(key: string): void {
    if (this.removeTimers.has(key)) return
    const timer = setTimeout(() => {
      this.removeTimers.delete(key)
      this.items = this.items.filter((item) => item.key !== key)
      this.emit()
    }, MESSAGE_REMOVE_DELAY)
    this.removeTimers.set(key, timer)
  }

  private emit(): void {
    const snapshot = this.items
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}

export const defaultMessageController = new MessageController()
