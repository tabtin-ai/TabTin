import type { HomeSectionHandler } from './types'

/**
 * App 驱动的 Home 资源面板注册表。
 * 各 App 在此注册自己的 HomeSectionHandler，ContextHome 读取并动态生成 tabs。
 */
export class HomeSectionRegistry {
  private handlers = new Map<string, HomeSectionHandler>()

  /** 注册一个 App 的 Home Section */
  register(handler: HomeSectionHandler): void {
    this.handlers.set(handler.appId, handler)
  }

  /** 根据 appId 获取 handler */
  get(appId: string): HomeSectionHandler | undefined {
    return this.handlers.get(appId)
  }

  /** 获取所有已注册的 handler（按注册顺序） */
  getAll(): HomeSectionHandler[] {
    return Array.from(this.handlers.values())
  }

  /** 是否已注册某个 appId */
  has(appId: string): boolean {
    return this.handlers.has(appId)
  }
}
