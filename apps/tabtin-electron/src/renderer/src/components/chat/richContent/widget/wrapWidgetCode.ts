/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 1294-1352）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：chat 预览 srcdoc wrapper 构造 —— 将 widget 源代码包进 @tabtin/widget-tokens
 *       的标准 wrapper。该 wrapper 的 CSP / design tokens 与 Electron 烤图 +
 *       Daemon 烤图字面共用同一套 widget-tokens 包（wave 4 建立的抽象）。
 *
 *       **保留本层 wrapWidgetCode 包装函数而不是让消费方直接 import buildWrapper**：
 *       RichWidget.test.tsx / RichContentRenderer.tsx 都从原路径（RichContentRenderer）
 *       import wrapWidgetCode 并做字面 CSP / theme bundle 断言；拆分期间不改消费方
 *       import 路径（RichContentRenderer.tsx 做 barrel re-export），保持测试断言不变。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import { buildWrapper as buildWidgetWrapper } from '@tabtin/widget-tokens'

// Wave 4: light/dark token bundle 全部抽到 `@tabtin/widget-tokens` 包，
// 让 chat 预览（本文件 wrapWidgetCode）+ Electron 烤图（WidgetRenderService）
// + Daemon 烤图（DaemonBrowserService.captureWidget）三端**字面共用**同一份
// design tokens。CSP 也共用——避免 chat 预览能跑但烤图被 block 的视觉漂移。

/**
 * 把 widget 源代码包成 sandbox iframe 用的完整 HTML wrapper。
 *
 * CSP 与 widget RFC §四 4.4 字面对齐（硬约束）：
 *   - `default-src 'none'`：默认拒绝一切外链
 *   - `style-src 'unsafe-inline'`：允许 SVG 内联 style
 *   - `script-src 'unsafe-inline'`：允许 inline script（Wave 7 sendPrompt 需要）
 *     **不**含 https，所以外链 script 仍被拒
 *   - `img-src https: data:`：允许 https 图片 + base64
 *   - `font-src 'self' data:`：允许 base64 字体
 *
 * **Design tokens 主题切换（Wave 2.5 修齐）**：
 *
 * 桌面 chat 用 `.dark` class 手动切换主题（不是跟 OS prefers-color-scheme），
 * 旧实现 wrapper 用 `@media (prefers-color-scheme: dark)` 让 widget 跟 OS 走——
 * 用户 OS=light + app=dark 时 widget 内显示 light，整张卡片视觉真分裂。
 *
 * 修法：接收 `options.theme` 参数（'light' | 'dark'），按 chat UI 当前主题
 * 注入对应块；不再依赖 `prefers-color-scheme`。RichWidget 用 useIsDarkMode
 * 读 chat UI 主题传给 wrapper。
 *
 * 同时保留旧 `--widget-fg/--widget-bg/--widget-accent` 兼容映射——Wave 2
 * 已上线的 SVG（持久化到 content_blocks_json 的历史消息）仍能渲染。
 *
 * **导出原因**：测试可以单独断言 wrapper 输出含正确的 CSP 字面量 + `sandbox`
 * 属性留在 React iframe 上而不是 wrapper meta（避免 wrapper 内嵌 iframe 二级
 * sandbox 漂移）。
 */
export interface WrapWidgetOptions {
  /**
   * Chat UI 当前主题。决定 wrapper 注入 light 还是 dark 块的 token 值，让
   * widget 视觉跟桌面 chat UI 同步。缺省 'light' 兼容旧调用方。
   */
  theme?: 'light' | 'dark'
  /** Wave 7: exposed to iframe sendPrompt bootstrap; missing id makes sendPrompt no-op. */
  widgetId?: string
  /**
   * Lightbox 专用：让 sandbox iframe 文档自身二维滚动并接收有限缩放倍率。
   * 默认关闭，聊天内卡片仍保持 content-sized 测高语义。
   */
  lightboxViewport?: boolean
}

export function wrapWidgetCode(
  code: string,
  format: string,
  options: WrapWidgetOptions = {},
): string {
  // Wave 2 只支持 svg；其他 format 当 svg 处理（fallback）让流式期不 crash。
  void format
  // chat 预览路径：reducedMotion=false 让 fade-in 动画跑（用户能看到流式
  // 平滑出现）；系统 prefers-reduced-motion 媒体查询仍然由 widget-tokens
  // wrapper 注入兜底（封装在 buildWidgetWrapper 内）。
  // Electron 的独立 typecheck 解析 workspace 包已构建的 dist 声明；源码新增
  // lightboxViewport 后，dist 会在正常 package build 更新。交叉类型同时让
  // 未重建 dist 的增量 typecheck 理解这个新增、向后兼容的选项。
  const wrapperOptions: NonNullable<Parameters<typeof buildWidgetWrapper>[1]> & {
    lightboxViewport?: boolean
  } = {
    theme: options.theme,
    reducedMotion: false,
    widgetId: options.widgetId,
    lightboxViewport: options.lightboxViewport,
  }
  return buildWidgetWrapper(code, wrapperOptions)
}
