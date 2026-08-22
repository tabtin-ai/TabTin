/**
 * Compact 路径——摘要输入瘦身的占位字符串（ 第二波）。
 *
 * SSoT 由本文件持有（宪法 v0.1 §3.1 "含 marker 字符串"硬条件）。
 *
 * **只用于摘要请求的输入拷贝，永不写回真实对话历史**：
 * - `slimMessagesForSummaryInput`（compact.ts）把送给摘要模型的消息拷贝里
 *   白名单工具的旧 tool_result 替换为 `SUMMARY_INPUT_TOOL_RESULT_OMITTED`、
 *   图片块替换为 `SUMMARY_INPUT_IMAGE_OMITTED` 文本块；
 * - 真实 `state.messages` 一个字节不动——提示词缓存零损伤；
 * - 与 time-based microcompact 的 `[旧工具结果内容已清除]` 占位刻意不同文案：
 *   后者写进真实历史、模型看到后应自觉重跑工具；本占位只出现在摘要模型的
 *   一次性输入里，语义是"摘要时省略了可重新获取的原始输出"。
 */

export const SUMMARY_INPUT_TOOL_RESULT_OMITTED =
  '[工具原始输出已在摘要输入中省略——结论见相邻助手消息，原文仍在对话历史]';

export const SUMMARY_INPUT_IMAGE_OMITTED = '[图片已在摘要输入中省略]';
