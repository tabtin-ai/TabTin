/**
 * Compact 路径——全量 LLM 摘要的 system prompt。
 *
 * SSoT 由本文件持有。来源为旧 `compact/compact.ts:39-49` 的 `COMPACT_SYSTEM_PROMPT`
 * inline 常量；按宪法 v0.1 §3.1（agent-runtime 引擎内部 prompt 走
 * `packages/agent-runtime/src/prompts/`）资源化。
 *
 * 受众：runtime 主开 / Prompt 工程师。改动方式：git PR + snapshot 测试。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；原"弱模型对中文 system 遵从度低"
 * 结论已由该决策推翻，质量验证推迟到 dogfood 真实触发时人工观察，见宪法 §3.6 修订）。
 */
export const COMPACT_SYSTEM_PROMPT = [
  '你是一个对话摘要器。请为给定的对话生成一份详细、结构化的摘要，',
  '重点保留那些对于不丢失上下文、继续推进工作至关重要的信息。',
  '',
  '关键：你的摘要将替换原始消息。任何未包含在摘要中的信息，',
  '都会从活动上下文中永久丢失。',
  '请力求详尽——宁可多写，也不要漏写。',
  '',
  '只回复摘要正文本身。不要调用任何工具。',
].join('\n');
