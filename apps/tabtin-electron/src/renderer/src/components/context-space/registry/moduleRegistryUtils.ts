/**
 * 当前隐藏的 App ——这些 ContextTypeHandler 与 HomeSection 都不会被自动注册。
 *
 * - `tabsite`：依据 `docs/single-root-space-prd.md` §2.6（C 方案）下架。
 *   `Site.code_project_path` 是隐性的"第二个项目根"，跟单根契约冲突；
 *   底层代码 + Django models / API / 前端组件全部保留，仅禁用入口。
 *   未来要重启时把 'tabsite' 从这里删掉，并补上"站点目录限定在 working_dir 内"的约束。
 * - `tins`：2026-06-03 决策，Tin 暂不开放正式入口；底层 runtime / API 保留，
 *   UI 入口由 `TINS_UI_ENABLED` 控制。
 * - `tabslide`（Home section）：2026-07决策，TabSlide App UI 暂不上线，
 *   Home 面板入口仍隐藏。底层引擎 / API / 编辑器组件保留，UI 入口由
 *   `TABSLIDE_UI_ENABLED` 控制。
 * - `slide`（handler）： 起即使 UI 关闭也注册，只为向 Agent `<apps>` 提供
 *   displayName / cliKey=slide 元数据；quickAction / searchable 在 handler 内
 *   按 `TABSLIDE_UI_ENABLED` 关闭，避免侧边栏「新建」与搜索重新露出入口。
 */
import { TINS_UI_ENABLED, TABSLIDE_UI_ENABLED } from '@/utils/featureFlags'

export const HIDDEN_APPS = new Set<string>([
  'tabsite',
  ...(TINS_UI_ENABLED ? [] : ['tins']),
  // UI 关时只藏 Home section；handler stem `slide` 始终注册。
  ...(TABSLIDE_UI_ENABLED ? [] : ['tabslide']),
])

/**
 * Handler 注册顺序（仅影响 tab 排列和 Quick Action 排列）。
 * Desktop 分组和排序已迁移到 manifest catalog.desktopGroup + order，不再由此控制。
 */
export const HANDLER_ORDER: string[] = [
  'browser', 'table', 'tabdoc', 'slide',
  'tabcode', 'tabchanges', 'tabsite',
  'folder', 'terminal', 'skill', 'tabtracker', 'tins',
  'downloads', 'history', 'bookmarks',
]

/**
 * Home section 注册顺序（仅影响 Home 面板内各 section 的排列）。
 * Desktop 分组和排序已迁移到 manifest catalog.desktopGroup + order，不再由此控制。
 */
export const HOME_SECTION_ORDER: string[] = [
  'tabweb', 'tabdata', 'tabdoc', 'tabslide',
  'folder', 'tabcode', 'orchestration',
  'tabtracker', 'tins', 'tabsite',
]

export function stemFromPath(path: string): string {
  return path.match(/\/([\w-]+)\.tsx?$/)?.[1] ?? ''
}

export function orderIndex(stem: string, order: string[]): number {
  const idx = order.indexOf(stem)
  return idx === -1 ? order.length : idx
}
