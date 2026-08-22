import type { TabCodeSidebarTab } from '../hooks/useTabCodeStore'

export type SidebarTabIntentSource = 'pending' | 'meta'

export interface ExternalSidebarTabIntent {
  tab: TabCodeSidebarTab
  source: SidebarTabIntentSource
  /** true：仓库未就绪，保留 pending/meta，稍后重试，切勿消费 */
  defer: boolean
}

function isSidebarTab(value: unknown): value is TabCodeSidebarTab {
  return value === 'git' || value === 'files' || value === 'search'
}

/**
 * 解析外部「打开侧栏某栏」意图（画布轨「提交或推送」等）。
 * pending 优先；meta.initialSidebarTab 仅在尚未消费时兜底。
 * Git 栏在仓库未就绪且未 assume 时必须 defer，避免冷启动把意图吃掉后回落到目录。
 */
export function resolveExternalSidebarTabIntent(input: {
  pending: TabCodeSidebarTab | null | undefined
  meta: unknown
  metaAlreadyConsumed: boolean
  isGitRepo: boolean
  /** 外层已确认 / 首帧乐观按仓库渲染时，允许立刻落到 Git 栏 */
  assumeGitRepo?: boolean
}): ExternalSidebarTabIntent | null {
  const fromPending = isSidebarTab(input.pending) ? input.pending : null
  const fromMeta =
    !fromPending
    && !input.metaAlreadyConsumed
    && isSidebarTab(input.meta)
      ? input.meta
      : null
  const tab = fromPending ?? fromMeta
  if (!tab) return null
  const repoReady = input.isGitRepo || Boolean(input.assumeGitRepo)
  return {
    tab,
    source: fromPending ? 'pending' : 'meta',
    defer: tab === 'git' && !repoReady,
  }
}
