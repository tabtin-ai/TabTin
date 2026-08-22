/**
 * desktopAppActivation —— 桌面「应用模式」启动器的单一激活逻辑
 *
 * 桌面工作台有三个 UI 都能激活一个 App，此前各自复制了同一段
 * `mode === 'create' ? createHandlers[id]?.() : onOpenAppHome(id)` 分支：
 *   - DesktopHomePane（主页「常用」磁贴的 activateApp）
 *   - DesktopSidebarPanel（左侧栏置顶应用行的 activateApp）
 *   - DesktopAppsPane（「更多应用」卡片「打开」按钮的 activateApp）
 * 三处收敛到这里，语义唯一：create 类应用走 createHandlers（新建资源），
 * 其余走 onOpenAppHome（打开应用主页）。行为与原三处逐字一致。
 */
import type { CreateResourceHandler } from './hooks/createResourceTypes'
import type { DesktopAppEntry } from './desktopAppsModel'

export interface DesktopAppActivationDeps {
  createHandlers: Record<string, CreateResourceHandler>
  onOpenAppHome: (appId: string, meta?: Record<string, unknown>) => void
}

/**
 * 激活一个桌面 App 目录项。
 * - `mode === 'create'`：调用对应的 createHandlers（缺失时 `?.()` 静默跳过，不抛错）；
 * - 其余（`mode === 'home'`）：打开该 App 的应用主页。
 */
export function activateDesktopAppEntry(
  entry: DesktopAppEntry,
  { createHandlers, onOpenAppHome }: DesktopAppActivationDeps,
): void {
  if (entry.mode === 'create') {
    createHandlers[entry.id]?.()
    return
  }
  onOpenAppHome(entry.id)
}
