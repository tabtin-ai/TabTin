/**
 * toolCardRegistry — 工具卡片注册表（合并入口）
 *
 * 集中所有工具的元信息：标签、图标、风险等级、摘要提取、渲染器名称。
 *
 * 数据源（按优先级从低到高 spread）：
 *  1. 主仓 spread —— 19 builtin App 的 *ToolCards.ts 文件，按域聚合（FILE / TERMINAL / WEB / DATA / DEVICE / AGENT / TABAPP）。
 *  2. marketplace manifest —— `packages/apps/<id>/tool-cards.json` 声明式条目，由 marketplaceToolCardDiscovery 通过
 *     `import.meta.glob` 编译期发现。
 *  3. marketplace factory —— `packages/apps/<id>/tool-cards/<name>.tsx` factory 默认导出，同上发现机制；优先级最高。
 *
 * 同名 toolName 出现在多通道时高优先级胜出（factory > manifest > 主仓 spread），
 * 由 `__tests__/toolCardRegistry.test.ts` 锁死。
 *
 * App 平台 H1 / Wave B-B2 决策：
 *  - 前端历史的 `'low'` 兼容路径已删除（消化 K8 / 统一 risk_level 词表为 safe/review/strict）；
 *    `RiskLevel` 实际仅消费 'safe' / 'review' / 'strict' + null（无 descriptor 时），见单测断言。
 *
 * 对应规范: docs/agent-chat/component-spec.md §2 Category B + docs/app-market/PRD-v3.md §5.4 B2。
 */

import type { RiskLevel, ToolCardDescriptor } from '@tabtin/chat-client'
import { FILE_TOOL_CARDS } from './fileToolCards'
import { HISTORICAL_TERMINAL_TOOL_CARDS, TERMINAL_TOOL_CARDS } from './terminalToolCards'
import { HISTORICAL_WEB_TOOL_CARDS, WEB_TOOL_CARDS } from './webToolCards'
import { DATA_TOOL_CARDS } from './dataToolCards'
import { DEVICE_TOOL_CARDS } from './deviceToolCards'
import { AGENT_TOOL_CARDS } from './agentToolCards'
import { TABAPP_TOOL_CARDS } from './tabappToolCards'
import { PRESENTATION_TOOL_CARDS } from './presentationToolCards'
import { discoverMarketplaceToolCards } from './marketplaceToolCardDiscovery'

/* ─── 注册表（合并所有通道，优先级 factory > manifest > 主仓 spread） ─── */

const { manifestCards, factoryCards, sources: _marketplaceSources } = discoverMarketplaceToolCards()

const _BUILTIN_SPREAD: Record<string, ToolCardDescriptor> = {
  ...FILE_TOOL_CARDS,
  ...TERMINAL_TOOL_CARDS,
  ...WEB_TOOL_CARDS,
  ...DATA_TOOL_CARDS,
  ...DEVICE_TOOL_CARDS,
  ...AGENT_TOOL_CARDS,
  ...TABAPP_TOOL_CARDS,
  // 富内容呈现重建 阶段 0/1：呈现类工具（show_widget /
  // semantic_search / code_semantic_search / parse_document / memory_search /
  // present_to_user）的工具卡降级 compact 单行——产物气泡（widget 画布 /
  // present_to_user 子卡）由 RichKindRouter 独立 mini-message
  // 承担，工具卡只剩"调了什么 + 一句话 summary"。
  //
  // **放在最后** spread——会覆盖 webToolCards / fileToolCards / agentToolCards
  // 等里同名条目。同时也是阶段 1 把其他呈现类工具一并降级的接入点。
  // 详见 ./presentationToolCards.ts 头部注释。
  ...PRESENTATION_TOOL_CARDS,
}

/**
 * Historical transcript display descriptors.
 *
 * These names are intentionally excluded from TOOL_CARDS so retired tool names
 * such as `web_fetch` do not appear in the current registry. Display lookups may
 * fall back here only when rendering old persisted messages.
 */
export const HISTORICAL_TRANSCRIPT_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  ...HISTORICAL_WEB_TOOL_CARDS,
  ...HISTORICAL_TERMINAL_TOOL_CARDS,
}

export const TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  // 1. 主仓 spread（最低优先级，被同名 marketplace 物料覆盖）
  ..._BUILTIN_SPREAD,
  // 2. marketplace manifest（packages/apps/<id>/tool-cards.json）
  ...manifestCards,
  // 3. marketplace factory（packages/apps/<id>/tool-cards/<name>.tsx）— 最高优先级
  ...factoryCards,
}

function getDisplayToolDescriptor(toolName: string): ToolCardDescriptor | null {
  return TOOL_CARDS[toolName] ?? HISTORICAL_TRANSCRIPT_TOOL_CARDS[toolName] ?? null
}

// dev-only：marketplace 物料覆盖 builtin 时打 info，便于排查"为什么 tool X 行为变了"
if (process.env.NODE_ENV !== 'production') {
  for (const [toolName, source] of Object.entries(_marketplaceSources)) {
    if (toolName in _BUILTIN_SPREAD) {
      console.info(
        `[ToolCardRegistry] tool "${toolName}" 被 marketplace App "${source.appId}" ` +
        `(${source.channel} 通道) 覆盖了主仓 builtin descriptor`,
      )
    }
  }
}

/* ─── 查询辅助 ─── */

/** Tool Card 实际承认的 risk level 词表（含 null 兜底） */
export type ToolCardRiskLevel = Extract<RiskLevel, 'safe' | 'review' | 'strict'> | null

const LOW_RISK_SET = new Set(
  Object.entries(TOOL_CARDS)
    .filter(([, d]) => d.riskLevel === 'safe')
    .map(([name]) => name),
)

/** 获取工具的完整描述符，未注册工具返回 null */
export function getToolDescriptor(toolName: string): ToolCardDescriptor | null {
  return getDisplayToolDescriptor(toolName)
}

/**
 * 判断工具是否为低风险（可被分组折叠）
 *
 * App 平台 H1 / Wave B-B2：仅承认 `riskLevel === 'safe'`；前端历史的 'low' 兼容路径已删除。
 */
export function isLowRiskTool(toolName: string): boolean {
  return LOW_RISK_SET.has(toolName)
}

/** 获取工具的显示标签 i18n key，未注册工具返回 null */
export function getToolLabelKey(toolName: string): string | null {
  return getDisplayToolDescriptor(toolName)?.labelKey ?? null
}

/** 获取工具的紧凑摘要（用于卡片头部） */
export function getCompactSummary(toolName: string, input: unknown, _output?: unknown): string | null {
  const desc = getDisplayToolDescriptor(toolName)
  if (!desc?.compactSummary) return null
  return desc.compactSummary(input)
}

/** 提取工具输出的结构化数据 */
export function extractToolOutput(toolName: string, output: unknown): import('@tabtin/chat-client').ToolOutputData | null {
  const desc = getDisplayToolDescriptor(toolName)
  if (!desc?.extractOutput) return null
  return desc.extractOutput(output)
}

/** 获取工具的渲染器名称 */
export function getToolRenderer(toolName: string): string {
  return getDisplayToolDescriptor(toolName)?.renderer ?? 'GenericToolCard'
}

/** 获取工具图标名 (lucide icon name) */
export function getToolIcon(toolName: string): string {
  return getDisplayToolDescriptor(toolName)?.icon ?? 'Wrench'
}

/**
 * 获取工具风险等级
 *
 * App 平台 H1 / Wave B-B2：返回值收口到 `safe / review / strict / null` 四元组（含 null）；
 * 未注册工具返回 null（旧版默认 'medium' 在 K8 词表统一时已废弃）。
 */
export function getToolRiskLevel(toolName: string): ToolCardRiskLevel {
  const raw = TOOL_CARDS[toolName]?.riskLevel
  if (raw === 'safe' || raw === 'review' || raw === 'strict') return raw
  return null
}
