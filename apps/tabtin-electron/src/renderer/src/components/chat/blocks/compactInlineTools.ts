/**
 * Compact inline tool registry —— 仅"富内容呈现类"工具走单行简洁文本，
 * 其余工具（含信息读取 / 检索类）统一走可折叠的 ToolStepCard 卡片。
 *
 * **产品语义（统一卡片化之后）**：
 *
 * 工具调用统一为「折叠行（图标 + 可读描述）/ 下沉卡片展开」一种形态——
 * read / search / list / skills 等信息读取类也走卡片（折叠态只占一行、连续
 * 多张由 BlockTimeline 自动收进 CollapsibleToolCardGroup，不刷屏）。
 *
 * **呈现类分两档**：
 *   - `present_to_user` → PresentationToolFoldRow（折叠 step row，产物仍在 mini-message）
 *   - 其余呈现类 → compact 单行
 * parse_document。这类工具的产物在**独立 mini-message 气泡**里另起
 * RichKindRouter 渲染（widget 画布 / present 子卡 / 文档摘录）。
 * 若工具卡也改成可展开卡片，展开区会与 mini-message 重复显示
 * 同一份产物，故保留 compact 单行——只显示"调了哪个呈现工具 + 一句话简介"。
 * 详见 ../registry/presentationToolCards.ts。
 *
 * 渲染契约（与 ToolUseBlockView / ToolResultBlockView 对接）：
 *   - **ToolUseBlockView**：白名单（呈现类）工具 → 单行简洁视图，跳过
 *     ToolStepCard；其余工具走统一 ToolStepCard 卡片
 *   - **错误降级**：呈现类工具的 tool_use 在 parseError / partial 时，强制
 *     退回完整 ToolStepCard 路径（让用户看到诊断信息），不走 compact
 */

const COMPACT_INLINE_TOOLS: ReadonlySet<string> = new Set([
  // ── 富内容呈现类工具（唯一保留 compact 的一档）──
  //
  // 这些工具的产物（widget 画布 / present 子卡 / 文档摘录）
  // 走**独立 mini-message 气泡**渲染（详见 ../registry/presentationToolCards.ts）。
  // 工具卡若也改成可展开卡片，展开区会与 mini-message 重复显示同一份产物，
  // 故这类保持 compact 单行——只显示"调了什么 + summary"。
  'show_widget',
  'parse_document',
])

/** 产物只在输入区 TodoPanel 展示、不在对话流渲染的工具 */
const PANEL_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'todo',
])

/**
 * 当前工具是否应该走简洁单行模式。
 *
 * 调用方应当**只在 finalize 后稳定路径**调用——流式期间 / parseError /
 * partial 等异常场景应该退回完整 ToolStepCard 路径让用户看到诊断信息。
 */
export function isCompactInlineTool(toolName: string): boolean {
  return COMPACT_INLINE_TOOLS.has(toolName)
}

/**
 * 产物由输入区固定面板承载（如 TodoPanel），对话流内不重复渲染工具卡。
 */
export function isPanelOnlyTool(toolName: string): boolean {
  return PANEL_ONLY_TOOLS.has(toolName)
}

/**
 * 暴露白名单 Set 给单测使用——保证"添加新工具"的回归测试能直接 assert。
 *
 * 不暴露 `Set.add` / `Set.delete` 等可变方法（标 `ReadonlySet`），调用方
 * 只能读不能改。
 */
export function getCompactInlineToolsSet(): ReadonlySet<string> {
  return COMPACT_INLINE_TOOLS
}
