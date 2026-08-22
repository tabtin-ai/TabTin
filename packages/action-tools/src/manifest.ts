import type { ToolManifest, ToolRiskLevel } from './types/manifest'
import type { AgentTool } from './types'
import { allDomains } from './tools'

// ========== 工具 manifest 生成 ==========

/** 与 Django action_tool_registry 对齐；工具/组可声明 optional（类型在 tools 层扩展）。 */
type ToolManifestRow = ToolManifest & { optional: boolean }

const DEFAULT_RISK: ToolRiskLevel = 'review'

const isAgentTool = (tool: unknown): tool is AgentTool =>
  typeof tool === 'object' && tool !== null && 'description' in tool && 'parameters' in tool

export const toolManifests: ToolManifestRow[] = allDomains
  .flatMap(({ meta, groups }) =>
    groups.flatMap(group => {
      // 工具系统宪法 §不变量 2（W5 实施 2026-05-04，W5 收尾反转默认值）：
      // **白名单模式** —— 默认不暴露给 LLM，必须显式 opt-in `manifestExposed: true`。
      // 业务能力一律走 `tabtin <command>` CLI；ActionExecutor adapter 仍注册其
      // tool execute()，CLI server 路由可继续派发（如 /browser/act → execute_act）。
      // group.manifestExposed 为同位 override，可反向覆盖 domain（如 core 域整体
      // 不暴露但 terminal/skills 组要 opt-in）。
      const exposed = group.manifestExposed ?? meta.manifestExposed ?? false
      if (!exposed) return []
      // WP5（PTY 化总控）：llm_facing 字段优先级 tool > group > domain > default(true)。
      // 4 件套 group 显式 `llmFacing: false`，标记"保留作 TerminalRuntimeBridge 适配层 +
      // 远端 frontend_action / IPC 路径 / 枚举 API 消费"但**不应该**被 LLM 主路径 /
      // MCP server / SKILL.md 引导。默认 true 避免突然丢字段把其他工具误伤为非 LLM 工具。
      // tool 层 `llmFacing` 在 `AgentTool` interface 显式声明（types/index.ts），typo
      // 可被 TS 编译期 catch。
      const groupLlmFacing = group.llmFacing ?? meta.llmFacing
      return group.tools
        .filter(isAgentTool)
        .map(tool => {
          const llmFacing = tool.llmFacing ?? groupLlmFacing
          const row: ToolManifestRow = {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            appId: meta.appId,
            executionTarget: 'frontend' as const,
            riskLevel: tool.riskLevel ?? group.riskLevel ?? meta.riskLevel ?? DEFAULT_RISK,
            tags: group.tags ?? meta.tags,
            headless: meta.headless ?? true,
            optional:
              (tool as { optional?: boolean }).optional ??
              (group as { optional?: boolean }).optional ??
              false,
          }
          if (llmFacing === false) {
            row.llm_facing = false
          }
          return row
        })
    })
  )

export const getToolManifests = (): ToolManifestRow[] =>
  toolManifests.map(m => ({ ...m }))

export const getToolCapabilityMap = (): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const { meta, groups } of allDomains) {
    for (const group of groups) {
      const exposed = group.manifestExposed ?? meta.manifestExposed ?? false
      if (!exposed) continue
      const cap = group.capability ?? meta.capability
      if (!cap) continue
      for (const tool of group.tools) {
        if (!isAgentTool(tool)) continue
        map[tool.name] = cap
      }
    }
  }
  return map
}
