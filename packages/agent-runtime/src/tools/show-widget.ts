/**
 * 重构来源：本文件原本是 711 行单体实现（2026-04-30 前）
 * 拆分时间：2026-04-30
 * 重构原因：show-widget.ts 711 行单文件过大，按职责拆分
 * 职责：re-export barrel —— 保留原路径兼容所有现有消费方
 *       （`tools/index.ts`、`presentation-tools.ts`、tests/show-widget*.ts 等），
 *       实际实现迁移到 ./show-widget/ 子目录：
 *         - show-widget/sanitizer.ts           （`hasDangerousHtml` / `hasDangerousMermaidSource` / `scrubSvg`）
 *         - show-widget/mermaid-compiler.ts    （`prepareWidgetSource` / Mermaid SDK 驱动）
 *         - show-widget/tool-call-id-finder.ts （`findToolCallIdHeuristically` / `__resetShowWidgetUsedRefsForTests` / WeakSet used-refs 状态）
 *         - show-widget/index.ts               （`createShowWidgetTool` + execute 主干 + `SHOW_WIDGET_TOOL_NAME`）
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

export * from './show-widget/index.js'
