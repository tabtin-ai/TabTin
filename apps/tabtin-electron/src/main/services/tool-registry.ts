/**
 * tool-registry.ts — 工具注册模块
 *
 * 将所有 @tabtin/action-tools 工具集批量注册到 ActionExecutorAdapter。
 * 从 FrontendActionBridge 构造函数中抽离，保持注册逻辑集中可维护。
 *
 * 设计：从 allDomains 自动遍历注册，与 Daemon 端 createHeadlessAdapter
 * (packages/action-tools/src/headless.ts) 保持一致模式。
 * 新增 domain/group 后 Electron 自动获得，无需手动同步。
 */

import type { ActionExecutorAdapter } from '@tabtin/action-tools/adapters'
import type { AgentTool } from '@tabtin/action-tools/types'
import {
  allDomains,
  // ── tabcode 全量（覆盖 allDomains 中的只读子集） ─────────
  tabcodeTools,
  setOnRulesChanged,
} from '@tabtin/action-tools/tools'

import { refreshFetchInterception } from './CDPNetworkBridge'
import { localMcpAgentTools } from './local-mcp-agent-tools'
import { createLogger } from '../logger'

const log = createLogger('ActionBridge:ToolRegistry')

export function registerAllTools(adapter: ActionExecutorAdapter): () => void {
  // allDomains 自动遍历：tabcode 跳过（allDomains 仅含只读子集，下方注册全量）
  for (const domain of allDomains) {
    if (domain.meta.appId === 'tabcode') continue
    for (const group of domain.groups) {
      adapter.registerTools(group.tools as AgentTool[])
    }
  }

  adapter.registerTools(tabcodeTools)

  adapter.registerTools(localMcpAgentTools)

  setOnRulesChanged((tabId: string) => {
    refreshFetchInterception(tabId).catch(err => {
      log.warn('Fetch interception refresh failed:', err?.message)
    })
  })

  return () => {
    setOnRulesChanged(null)
  }
}
