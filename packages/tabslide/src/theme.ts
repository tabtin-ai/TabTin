/**
 * TabSlide 主题 Token
 *
 * 消费宿主环境（TabTin Electron）的 CSS 自定义属性。
 * 所有 token 带 fallback，脱离宿主也能正常渲染。
 *
 * 视觉层级（由外到内）：
 *   bgApp      → #FFFFFF  白色面板（工具栏、侧边栏、属性面板）
 *   bgCanvas   → #F5F5F5  画布容器灰底（幻灯片周围的灰色工作区）
 *   bgSurface  → #FFFFFF  幻灯片页面本身
 *
 * 平台 CSS 变量来源：globals.css (:root)
 *   --tabslide-bg:          0 0% 100%      → #FFFFFF  TabSlide 面板白色背景
 *   --tabslide-canvas:      0 0% 96%       → #F5F5F5  TabSlide 画布容器灰底
 *   --canvas:             220 24% 97%    → #F5F7FB  主应用工作区底色
 *   --background:         0 0% 100%      → #FFFFFF  内容表面
 *   --foreground:         222 22% 12%    → #1D2433  主文字
 *   --muted:              220 18% 96%                柔和背景
 *   --muted-foreground:   220 8% 44%                 次要文字
 *   --border:             220 12% 90%                边框
 *   --accent:             218 84% 56%                强调色
 *   --destructive:        0 84.2% 60.2%              危险色
 *   --radius:             0.6rem                     圆角基准
 */

// ── 语义化背景 ──

/** 面板 / 工具栏 / 侧边栏背景（白色，与主应用 --canvas 区分） */
export const bgApp = 'hsl(var(--tabslide-bg, 0 0% 100%))'

/** 画布容器背景（幻灯片周围的灰色工作区） */
export const bgCanvas = 'hsl(var(--tabslide-canvas, 0 0% 96%))'

/** 工作区背景（编辑器最外层底色，跟随主应用 --canvas） */
export const bgWorkspace = 'hsl(var(--canvas, 220 24% 97%))'

/** 内容表面（幻灯片本身、弹窗、卡片） */
export const bgSurface = 'hsl(var(--background, 0 0% 100%))'

/** 柔和背景层（hover 底色、输入框底色） */
export const bgMuted = 'hsl(var(--muted, 220 18% 96%))'

/** hover 态背景（中性黑灰） */
export const bgHover = 'hsl(var(--muted, 220 18% 96%) / 0.85)'

/** 按压/激活态背景 */
export const bgActive = 'hsl(var(--muted, 220 18% 96%))'

// ── 文字 ──

/** 主文字色 */
export const textPrimary = 'hsl(var(--foreground, 222 22% 12%))'

/** 次要文字 */
export const textSecondary = 'hsl(var(--muted-foreground, 220 8% 44%))'

/** 三级文字（占位、提示） */
export const textTertiary = 'hsl(var(--muted-foreground, 220 8% 44%) / 0.6)'

// ── 边框 ──

/** 标准边框 */
export const border = 'hsl(var(--border, 220 12% 90%))'

/** 轻量边框 */
export const borderLight = 'hsl(var(--border, 220 12% 90%) / 0.5)'

/** 强化边框（用于操作栏分组） */
export const borderStrong = 'hsl(var(--border, 220 12% 90%) / 0.9)'

// ── 强调色 ──

/** 主强调色（选中、激活） */
export const accent = 'hsl(var(--accent, 218 84% 56%))'

/** 强调色浅底 */
export const accentBg = 'hsl(var(--accent, 218 84% 56%) / 0.06)'

/** 强调色中等 */
export const accentMedium = 'hsl(var(--accent, 218 84% 56%) / 0.5)'

/** 强调色文字 */
export const accentForeground = 'hsl(var(--accent-foreground, 0 0% 98%))'

// ── 危险色 ──

export const danger = 'hsl(var(--destructive, 0 84.2% 60.2%))'
export const dangerBg = 'hsl(var(--destructive, 0 84.2% 60.2%) / 0.06)'

// ── 圆角 ──

export const radiusSm = 'calc(var(--radius, 0.6rem) - 4px)'
export const radiusMd = 'calc(var(--radius, 0.6rem) - 2px)'
export const radiusLg = 'var(--radius, 0.6rem)'

// ── 阴影（中性清爽风：全局无阴影，仅靠边框与留白区分层级） ──

/** 轻微投影 — 归零 */
export const shadowSm = 'none'

/** 中等投影 — 归零 */
export const shadowMd = 'none'

/** 较重投影（仅弹出菜单保留极淡投影以示浮层） */
export const shadowLg = '0 2px 8px hsl(var(--foreground, 222 22% 12%) / 0.06)'

/** 面板细阴影 — 归零 */
export const shadowPanel = 'none'

/** 浮层阴影（工具栏胶囊、侧栏、下拉层） */
export const shadowFloating = 'var(--tabslide-floating-shadow, 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1))'

/** 主画布阴影（编辑态幻灯片容器） */
export const shadowCanvas = 'var(--tabslide-canvas-shadow, 0 12px 30px rgba(15,23,42,0.12), 0 4px 10px rgba(15,23,42,0.08))'

// ── 字体 ──

export const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'

// ── 动效 ──

export const transitionFast = '0.12s ease'
export const transitionNormal = '0.2s ease'
