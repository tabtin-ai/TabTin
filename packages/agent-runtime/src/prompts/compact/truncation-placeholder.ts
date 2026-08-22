/**
 * Compact 路径——单文件 attachment 截断占位文案。
 *
 * SSoT 由本文件持有。来源为旧 `compact/compact.ts:503` 中
 * `'\n\n... [content truncated for context budget] ...\n\n'` 内联字符串；
 * 按宪法 v0.1 §3.1（"极短文案"+"含 marker 字符串"硬条件）资源化。
 *
 * 用途：extractFileAttachments 计算单文件 token 数超 maxPerFile 预算时，
 * 取头尾切片中间用本占位字符串拼接——让 Agent 看到"这里有截断不是文件
 * 真实结尾"。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化）。
 */

export const CONTEXT_TRUNCATED_PLACEHOLDER =
  '\n\n... [内容因上下文预算已截断] ...\n\n';
