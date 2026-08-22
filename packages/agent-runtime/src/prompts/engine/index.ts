/**
 * Engine-default prompt resources barrel.
 *
 * 阶段 2.1 清理（2026-05-20）：删除 `./identity.js` / `./safety.js` /
 * `./persistence.js` / `./proactive-report-rules.js` 4 个英文老 prompt 文件
 * （ENGINE_IDENTITY_PROMPT / SYSTEM_IDENTITY_PROMPT / ENGINE_SAFETY_PROMPT /
 * SYSTEM_SAFETY_PROMPT / ENGINE_EXECUTION_PROMPT / SYSTEM_PERSISTENCE_PROMPT
 * / PROACTIVE_REPORT_RULES）—— 替代物：
 *   - identity / safety / execution 中文段由 `@tabtin/agent-prompt` 的
 *     `buildIdentitySection` / `SECTION_SAFETY` / `SECTION_EXECUTION` 提供
 *   - PROACTIVE_REPORT_RULES 段从未被 hook 注入到 system prompt（只有
 *     barrel re-export + tests，0 production caller），整段下线
 *
 * + 99_治理基线候选.md 阶段 2.1。
 *
 * 本文件保留为占位 —— 其余 engine prompt 常量（譬如
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY / budget-notices builders）从各自专用文件
 * 直接 import，不再走本 barrel。
 */

export {};
