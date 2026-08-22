/**
 * Capability/governance——CostCap 写入 system prompt 的 token 压力 hint 文案。
 *
 * SSoT 由本文件持有。来源为旧 `capability/governance/cost.ts:104-110` 的
 * `CONVERGENCE_HINT_WARNING` / `CONVERGENCE_HINT_ERROR` inline 常量；
 * 按宪法 v0.1 §3.1 资源化。
 *
 * 用途：CostCap.beforeIteration 在每轮估当前 token 数后，按
 * `calculateTokenWarningState` 分类（normal/warning/error/blocking），把对应
 * hint 缓存在 CostCap 实例字段——beforeModel 经 appendSystemSection 注入 system prompt
 * 让 LLM 感知"该收口了"。
 *
 * 与 budget-notices 的关系：budget-notices 是"达 warn/grace/terminate 阶段
 * 的预算系统通知"（按 iteration / token 比例触发），convergence-hints 是
 * "context window 压力级别提示"（按 estimatedTokens / contextWindow 比例触发），
 * 两者正交。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；原"引擎内部英文"惯例已由该决策推翻，
 * 见宪法 §3.6 修订。与 budget warn/grace 系统注入一致）。
 */

export const CONVERGENCE_HINT_WARNING =
  '[系统] 上下文空间有限。请优先完成当前任务，' +
  '避免读取大文件或运行输出冗长的命令。';

export const CONVERGENCE_HINT_ERROR =
  '[系统] 上下文空间已严重不足。你必须立即完成当前工作，' +
  '不要开启新的探索。现在就总结并交付结果。';
