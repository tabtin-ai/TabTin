import type { AgentTool } from '../../types'
import type { ToolDomain } from '../../types/manifest'

import { terminalTools } from '../terminal'

/**
 * Core execution-plane tools for headless and Electron adapters.
 *
 * Wave 4a (2026-05-01): tabdataTools 7 + 5 个 FC 全部删除（D4 全删 FC）。
 * Agent 操作多维表格走 `tabtin table *` CLI（execute_in_terminal 调用）。
 *
 * W5 收尾（2026-05-04，白名单反转）：core 域 `manifestExposed` 默认 false，
 * 由各 group 显式 opt-in 暴露：
 *   - terminalTools group `manifestExposed: true` — 4 件套（execute_in_terminal /
 *     read_terminal_output / list_terminal_sessions / write_to_terminal）
 *
 * W6 (2026-05-04): the `tabslideTools` adapter-only group was deleted.
 * Slide operations now flow through `tabtin slide *` CLI → Django REST
 * directly, with no Action Executor mapping in between.
 *
 * W7 (2026-05-05): skillsTools (skills_read) 从 action-tools 下架。
 * skills_read 新版已迁至 agent-runtime SkillsCap（key 式 schema），
 * 旧版路径式 schema 是僵尸工具，LLM 从不使用。
 *
 * **WP5（本地 LLM 终端 PTY 化 总控，2026-05-14）**：terminalTools group 标
 * `llmFacing: false`。本地 LLM 主路径走 ShellCap 单工具 `run_terminal_command`
 * （D2 决策）—— 走 `PtyManagerBridge`（agent-bridge.ts 的"AI 控"接口）。
 * 4 件套**保留在 manifest 中**（供枚举 API `get_all_action_tools()` /
 * 远端 WS frontend_action 路径 / Electron renderer IPC / FrontendActionBridge
 * 等人控消费者用），它们走的是 `TerminalRuntimeBridge` / `PtyManagerAPI`（runtime-bridge.ts
 * 的"人控"接口，与 `PtyManagerBridge` 独立 set / resolve、互不污染——见
 * `agent-bridge.ts` JSDoc L29-37）。
 *
 * 下游 LLM-facing 消费方按 `llm_facing === false` 过滤：MCP server adapter 不再
 * 暴露 4 件套 / SKILL.md 不写 4 件套示例 / agent-runtime capability 系统自身就
 * 不组装 4 件套到 LLM tool schema。
 *
 * `manifestExposed: true` 与 `llmFacing: false` 并存的语义：
 *   - manifestExposed=true → 工具进 manifest.json，下游可枚举到（人控消费者用得到）
 *   - llmFacing=false → 标注"不是 LLM 工具"，下游 LLM-facing 列表应自动过滤
 *
 * TabCode full write set stays out of manifest domains（见 tabcode/_meta
 * 只读子集）；adapters register `tabcodeTools` separately.
 */
export const domain: ToolDomain<AgentTool> = {
  meta: {
    appId: 'core',
    capability: 'execution',
    headless: true,
  },
  groups: [
    { tools: terminalTools, manifestExposed: true, llmFacing: false },
  ],
}
