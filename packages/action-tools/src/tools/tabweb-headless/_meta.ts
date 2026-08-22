import type { AgentTool } from '../../types'
import type { ToolDomain } from '../../types/manifest'

import { browserTools } from '../browser'
import { tabManagementTools } from '../tab-management'
import { tabNavigationTools } from '../tab-navigation-tools'
import { evalTools } from '../eval'
import { antiDetectTools } from '../anti-detect'
import { screenshotTools } from '../screenshot'
import { pdfTools } from '../pdf'
import { markdownTools } from '../markdown'
import { sessionTools } from '../session-tools'
import { resourceDetectionTools } from '../resource-detection'
import { resourceDownloadTools } from '../resource-download'
import { networkTools } from '../network'

/**
 * Headless-compatible browser tools.
 *
 * 这些工具通过 L2 BrowserContext 抽象（headless 用 Patchright）+ runtime-bridge
 * 注入接口运行，不依赖 Electron GUI。
 *
 * Wave 4a (2026-05-01) 清理：
 *   - 删 webFetchTools / webFetchBatchTools / webExtractTools /
 *     webExtractToTableTools / crawlTools — 5 个 tabweb 数据采集 FC
 *     按 D4 全删，Agent 抓取页面 / 提取结构化数据走 `tabtin browser *` CLI。
 *   - 保留底层 impl（packages/action-tools/src/impl/CrawlToolImpl /
 *     web-fetch-pipeline 等）供 cli-server routes 调用。
 *   - 保留 GUI bridge 类工具（按 D6）：browserTools / sessionTools /
 *     screenshot / pdf / markdown / eval / anti-detect / network /
 *     tab-management / tab-navigation / resource-detection / resource-download
 *     —— 这些本来就含「Agent 直接调 GUI / CDP」语义。
 *
 * Groups with `requires: ['browser']` 仅在运行时具备 'browser' capability
 * 时注册（参见 createHeadlessAdapter）。
 *
 * 排除项（GUI-only，不进 headless）：
 *   - contextSpace（仅 Electron 工作区布局）
 */
export const domain: ToolDomain<AgentTool> = {
  meta: {
    appId: 'tabweb',
    capability: 'browser',
    riskLevel: 'review',
    headless: true,
    // W5（2026-05-04，工具系统宪法 §不变量 2 + W5 收尾白名单反转）：tabweb-headless
    // 整域不 opt-in `manifestExposed`（默认 false）—— LLM 通过 `tabtin browser *` CLI
    // 调用所有浏览器能力（`tabtin commands` 自描述）。tool execute() 仍由
    // ActionExecutor adapter 注册，daemon CLI server `/browser/act` 等路由通过
    // adapter.executeAction({ action_type: 'execute_act', ... }) 派发，整条数据通路
    // 与 LLM 前不变。
  },
  groups: [
    { tools: browserTools, riskLevel: 'review', tags: ['browser', 'automation'], requires: ['browser'] },
    { tools: tabManagementTools, riskLevel: 'review', tags: ['tab', 'management'], requires: ['browser'] },
    { tools: tabNavigationTools, riskLevel: 'safe', tags: ['tab', 'navigation'], requires: ['browser'] },
    { tools: evalTools, riskLevel: 'review', tags: ['eval'], requires: ['browser'] },
    { tools: antiDetectTools, riskLevel: 'safe', tags: ['anti-detect'], requires: ['browser'] },
    { tools: screenshotTools, riskLevel: 'safe', tags: ['screenshot'], requires: ['browser'] },
    { tools: pdfTools, riskLevel: 'safe', tags: ['pdf', 'export'], requires: ['browser'] },
    { tools: markdownTools, riskLevel: 'safe', tags: ['markdown', 'export'], requires: ['browser'] },
    { tools: sessionTools, riskLevel: 'review', tags: ['session', 'cookies'], requires: ['browser'] },
    { tools: resourceDetectionTools, riskLevel: 'safe', tags: ['resource', 'detection'], requires: ['browser'] },
    { tools: resourceDownloadTools, riskLevel: 'review', tags: ['resource', 'download'], requires: ['browser'] },
    { tools: networkTools, riskLevel: 'review', tags: ['network', 'route', 'console'], requires: ['browser'] },
  ],
}

export {
  browserTools,
  tabManagementTools,
  tabNavigationTools,
  evalTools,
  antiDetectTools,
  screenshotTools,
  pdfTools,
  markdownTools,
  sessionTools,
  resourceDetectionTools,
  resourceDownloadTools,
}
