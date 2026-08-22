import type { CrawlViewEventData } from '../crawl-view-events'

export interface EventFilterOptions {
  /**
   * 允许的事件类型列表，留空表示不过滤
   */
  allowTypes?: string[]
  /**
   * 是否忽略 console 级别（如 log/debug）
   */
  ignoreConsoleBelow?: 'log' | 'info' | 'warn' | 'error'
}

export class EventFilter {
  private options: EventFilterOptions

  constructor(options?: EventFilterOptions) {
    this.options = options || {}
  }

  update(options: Partial<EventFilterOptions>) {
    this.options = { ...this.options, ...options }
  }

  shouldPass(event: CrawlViewEventData): boolean {
    // 按类型过滤
    if (this.options.allowTypes && this.options.allowTypes.length > 0) {
      if (!this.options.allowTypes.includes(event.type)) {
        return false
      }
    }

    // console 级别过滤
    if (event.type === 'console:message' && this.options.ignoreConsoleBelow) {
      const level = event.data?.level
      const order: Record<string, number> = {
        log: 1,
        info: 2,
        warn: 3,
        error: 4
      }
      const min = order[this.options.ignoreConsoleBelow] || 1
      if (order[level] !== undefined && order[level] < min) {
        return false
      }
    }

    return true
  }
}

