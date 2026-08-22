/**
 * Engine 主循环——system prompt 静态/动态段分隔 marker。
 *
 * SSoT 由本文件持有。来源为旧 `engine/types.ts:138` 的
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` inline 常量；按宪法 v0.1 §3.1（"含 marker
 * 字符串——被代码 grep / cleanup 用"硬条件）资源化。
 *
 * **单一 SSoT**：
 * - `engine/query.ts` Phase 2 装配 system 时插入此 marker 划分静态前缀（identity /
 *   execution / safety / 工具列表）与动态后缀（user portrait / context / hint）。
 * - `providers/proxy-provider.ts` BP2（block-prefix-2）依赖此 marker 把 system
 *   切成两段，对静态前缀做 token cache（若 provider 支持）。
 * - 这个字符串**只能在本文件定义一次**——重复定义会让 BP2 / cache 失效或越界切分。
 *
 * 形态故意是 HTML comment：
 * - LLM 把 HTML comment 视为不可见——不会污染语义；
 * - `\n` 包裹 + 全大写 underscore——好被 `String.includes` / `split` / `trim` 命中。
 */

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '\n<!-- __DYNAMIC_BOUNDARY__ -->\n';
