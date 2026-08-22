/**
 * overlay-surface — 浮层统一材质（全局唯一真源）
 *
 * 所有脱离布局流的浮层（Popover / Dropdown / 右键菜单 / Select / Command / Dialog /
 * Sheet / Toast / Tooltip 等）统一使用此材质。**刻意不用毛玻璃、不蹭主题色**：
 * 不透明纯色面（亮白 / 暗黑）+ 1px 中性描边 + 单层浮层投影，与 globals.css 的
 * `.surface-glass-overlay` 口径一致（design-system §10.2 / §10.4 / §11.4）。
 *
 * 早期浮层为「暖灰半透明 + backdrop blur + saturate」毛玻璃，菜单上会透出底层暖色画布
 * 与主题色氛围光、整体泛主题色，观感别扭；现统一改为不透明中性面。
 *
 * - 底色取 `--glass-bg-overlay`（亮色纯白、暗色纯黑，不随品牌色方案换色相，不透底层）；
 * - 不再使用 `backdrop-filter` blur/saturate（不透明无需，亦杜绝底层色渗透）；
 * - 投影为唯一允许的一层 `--shadow-overlay`，外加 1px 中性 inset ring 勾边（不增盒模型）。
 *
 * 浮层组件只需附加本常量，不要再各自写 `bg-popover` / `backdrop-blur-*` /
 * `border` / `shadow-*`，避免材质散落不一致。
 */
export const OVERLAY_SURFACE_CLASS =
  'text-popover-foreground bg-[hsl(var(--glass-bg-overlay,var(--popover)))] [box-shadow:var(--shadow-overlay,0_10px_28px_hsl(var(--foreground)/0.08)),inset_0_0_0_1px_hsl(var(--border))]'

/**
 * 不透明浮层面 — 用于跨 BrowserWindow 的 overlay 子窗口。
 *
 * 与 OVERLAY_SURFACE_CLASS 同口径（不透明中性面，去毛玻璃），单列出仅为语义清晰：
 * 这类窗口的 CSS backdrop-filter 本就无法模糊主窗口内容。
 */
export const OPAQUE_OVERLAY_SURFACE_CLASS =
  'text-popover-foreground bg-[hsl(var(--glass-bg-overlay,var(--popover)))] [box-shadow:var(--shadow-overlay,0_10px_28px_hsl(var(--foreground)/0.08)),inset_0_0_0_1px_hsl(var(--border))]'
