import type { AgentTool } from '../../types'
import type { ToolDomain } from '../../types/manifest'

import { browserTools } from '../browser'
import { tabManagementTools } from '../tab-management'
import { tabNavigationTools } from '../tab-navigation-tools'
import { contextSpaceTools } from '../context-space'
import { sessionTools } from '../session-tools'
import { resourceDetectionTools } from '../resource-detection'
import { resourceDownloadTools } from '../resource-download'

/**
 * GUI-only browser tools — manifest domain.
 *
 * **W5（2026-05-04，工具系统宪法 §不变量 2 + W5 收尾白名单反转）**：业务能力走 CLI
 * 不走 FC。tabweb 整域不 opt-in `manifestExposed`（默认 false）—— LLM 不再看到
 * context-space FC，改用 `tabtin browser *` 系列 CLI 命令访问；但 tool execute()
 * 仍由 ActionExecutor adapter 注册，CLI server `/browser/*` 路由继续派发
 * （如 contextSpace 的派发路径）。
 *
 * networkTools removed from this domain in W1 — they were duplicated here
 * and in tabweb-headless. Only tabweb-headless retains them now.
 */
export const domain: ToolDomain<AgentTool> = {
  meta: {
    appId: 'tabweb',
    capability: 'browser',
    riskLevel: 'review',
    headless: false,
  },
  groups: [
    { tools: contextSpaceTools, riskLevel: 'review', capability: 'spacelayout', tags: ['spacelayout'] },
  ],
}

export {
  browserTools,
  tabManagementTools,
  tabNavigationTools,
  contextSpaceTools,
  sessionTools,
  resourceDetectionTools,
  resourceDownloadTools,
}
