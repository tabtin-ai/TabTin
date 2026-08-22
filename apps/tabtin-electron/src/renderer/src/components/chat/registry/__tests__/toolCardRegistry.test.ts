/**
 * toolCardRegistry — App 平台 H1 / Wave B-B2 双通道发现 + 优先级 + 词表收口测试
 *
 * 覆盖：
 *  1. 双通道发现：marketplace manifest (packages/apps/<id>/tool-cards.json) +
 *     factory tsx (packages/apps/<id>/tool-cards/<name>.tsx) 全部命中 TOOL_CARDS。
 *  2. 优先级（factory > manifest > 主仓 spread）：通过 marketplaceToolCardDiscovery 直接断言。
 *  3. 'low' 兼容路径删除：isLowRiskTool 不再认 'low'；getToolRiskLevel 收口到 4 元组。
 *  4. RiskLevel 类型断言（type-level）：ToolCardRiskLevel 仅含 safe/review/strict/null。
 */

import { describe, it, expect } from 'vitest'
import {
  HISTORICAL_TRANSCRIPT_TOOL_CARDS,
  TOOL_CARDS,
  isLowRiskTool,
  getToolDescriptor,
  getToolRiskLevel,
  getCompactSummary,
  type ToolCardRiskLevel,
} from '../toolCardRegistry'
import { discoverMarketplaceToolCards } from '../marketplaceToolCardDiscovery'
import { extractTerminal } from '../terminalToolCards'

describe('ToolCardRegistry — 双通道发现 (App 平台 B2)', () => {
  it('manifest entry id 与 key 不一致时被跳过（防御性）', () => {
    const { manifestCards } = discoverMarketplaceToolCards()
    for (const [toolName, descriptor] of Object.entries(manifestCards)) {
      expect(descriptor.id).toBe(toolName)
    }
  })

  it('sources 字段记录每个 marketplace toolName 的来源 App + 通道（dev 排错路径）', () => {
    const { manifestCards, factoryCards, sources } = discoverMarketplaceToolCards()
    // sources 应覆盖 manifest + factory 双通道并集
    const expected = new Set([...Object.keys(manifestCards), ...Object.keys(factoryCards)])
    expect(new Set(Object.keys(sources))).toEqual(expected)

    // factory 通道里的 entry，sources 应标 'factory'；manifest 同理
    for (const name of Object.keys(factoryCards)) {
      expect(sources[name].channel).toBe('factory')
      expect(typeof sources[name].appId).toBe('string')
      expect(sources[name].appId.length).toBeGreaterThan(0)
    }
    for (const name of Object.keys(manifestCards)) {
      // factory 优先：若同名也在 factoryCards 则 sources 已被覆盖为 'factory'，跳过断言
      if (name in factoryCards) continue
      expect(sources[name].channel).toBe('manifest')
      expect(typeof sources[name].appId).toBe('string')
      expect(sources[name].appId.length).toBeGreaterThan(0)
    }
  })
})

describe('ToolCardRegistry — 优先级 factory > manifest > 主仓 spread (App 平台 B2)', () => {
  it('web_search 使用 canonical search_term 作为折叠行摘要', () => {
    expect(getCompactSummary('web_search', { search_term: '亿信人形机器人产品型号' })).toBe(
      '亿信人形机器人产品型号',
    )
  })

  it('factory 优先于 manifest（同 toolName 在 manifest 与 factory 同时存在时 factory 胜出）', () => {
    // 验证机制：toolCardRegistry.ts 内 spread 顺序为 manifest 在前，factory 在后。
    // 由于 JS object spread 后者覆盖前者，factory 覆盖 manifest。
    const { manifestCards, factoryCards } = discoverMarketplaceToolCards()

    // 模拟同 toolName 在两通道并存的合并行为
    const merged = { ...manifestCards, ...factoryCards }
    const conflicts = Object.keys(manifestCards).filter(name => name in factoryCards)
    for (const name of conflicts) {
      expect(merged[name]).toBe(factoryCards[name])
      expect(merged[name]).not.toBe(manifestCards[name])
    }

    // 同时给一个 sanity test：合并对象包含双通道并集
    const allKeys = new Set([...Object.keys(manifestCards), ...Object.keys(factoryCards)])
    expect(Object.keys(merged).sort()).toEqual([...allKeys].sort())
  })

  it('主仓 spread 在缺 toolName 时 fallback（兼容 19 builtin App 的 Card）', () => {
    // 19 builtin 域的代表性 tool key（非 id 字段，注意 key 与 id 可能不同，参考各 *ToolCards.ts 文件）：
    const builtinSamples = [
      'run_terminal_command',          // current canonical command tool
      'execute_in_terminal',          // TERMINAL_TOOL_CARDS key
      'web_search',                    // WEB_TOOL_CARDS key
      'sql_query',                     // DATA_TOOL_CARDS key
      'agent',                         // AGENT_TOOL_CARDS key (id='subagent')
      'read_file',                      // FILE_TOOL_CARDS key
      'tabsite_create_site',            // TABAPP_TOOL_CARDS key
    ]
    for (const name of builtinSamples) {
      const desc = getToolDescriptor(name)
      expect(desc, `builtin tool "${name}" 未注册`).not.toBeNull()
    }
  })

  it('retired web_fetch 只保留 historical transcript display，不进入当前 registry', () => {
    expect(TOOL_CARDS.web_fetch).toBeUndefined()
    expect(HISTORICAL_TRANSCRIPT_TOOL_CARDS.web_fetch).toBeDefined()
    expect(getToolDescriptor('web_fetch')).toBe(HISTORICAL_TRANSCRIPT_TOOL_CARDS.web_fetch)
    expect(isLowRiskTool('web_fetch')).toBe(false)
  })

  it('retired terminal aliases 只保留 historical transcript display，不进入当前 registry', () => {
    expect(TOOL_CARDS.Bash).toBeUndefined()
    expect(TOOL_CARDS.bash).toBeUndefined()
    expect(TOOL_CARDS.shell).toBeUndefined()
    expect(HISTORICAL_TRANSCRIPT_TOOL_CARDS.Bash).toBeDefined()
    expect(HISTORICAL_TRANSCRIPT_TOOL_CARDS.bash).toBeDefined()
    expect(HISTORICAL_TRANSCRIPT_TOOL_CARDS.shell).toBeDefined()
    expect(getToolDescriptor('Bash')).toBe(HISTORICAL_TRANSCRIPT_TOOL_CARDS.Bash)
    expect(getToolDescriptor('bash')).toBe(HISTORICAL_TRANSCRIPT_TOOL_CARDS.bash)
    expect(getToolDescriptor('shell')).toBe(HISTORICAL_TRANSCRIPT_TOOL_CARDS.shell)
    expect(getToolDescriptor('Bash')?.labelKey).toBe('chat.card.historical_terminal')
    expect(getToolDescriptor('bash')?.labelKey).toBe('chat.card.historical_terminal')
    expect(getToolDescriptor('shell')?.labelKey).toBe('chat.card.historical_terminal')
    expect(isLowRiskTool('Bash')).toBe(false)
    expect(isLowRiskTool('bash')).toBe(false)
  })
})

describe('ToolCardRegistry — risk_level 词表收口 safe/review/strict (App 平台 B2 / K8)', () => {
  it('isLowRiskTool 不再认 "low"（仅 "safe" 视为低风险）', () => {
    // 取一个 risk=safe 的工具断言被识别为低风险
    const { manifestCards } = discoverMarketplaceToolCards()
    const safeManifestEntry = Object.values(manifestCards).find(d => d.riskLevel === 'safe')
    expect(safeManifestEntry, 'manifest 中应有 safe 卡片用于断言').toBeDefined()
    if (safeManifestEntry) {
      expect(isLowRiskTool(safeManifestEntry.id)).toBe(true)
    }

    // 任何 risk=review/strict 的工具不应被识别为低风险。不要依赖
    // marketplace factory 的 fixture 分布，直接从最终合并 registry 抽样。
    const reviewEntry = Object.values(TOOL_CARDS).find(d => d.riskLevel === 'review')
    expect(reviewEntry, 'TOOL_CARDS 中应有 review 卡片用于断言').toBeDefined()
    if (reviewEntry) {
      expect(isLowRiskTool(reviewEntry.id)).toBe(false)
    }

    const strictEntry = Object.values(TOOL_CARDS).find(d => d.riskLevel === 'strict')
    expect(strictEntry, 'TOOL_CARDS 中应有 strict 卡片用于断言').toBeDefined()
    if (strictEntry) {
      expect(isLowRiskTool(strictEntry.id)).toBe(false)
    }
  })

  it('getToolRiskLevel 默认值收口到 null（旧版默认 "medium" 已废弃）', () => {
    expect(getToolRiskLevel('this_tool_does_not_exist_xyz_42')).toBeNull()
  })

  it('getToolRiskLevel 仅返回 safe/review/strict/null 四元组', () => {
    const ALLOWED: ReadonlyArray<ToolCardRiskLevel> = ['safe', 'review', 'strict', null]
    const allTools = Object.keys(TOOL_CARDS)
    const allLevels = new Set(allTools.map(name => getToolRiskLevel(name)))
    for (const level of allLevels) {
      expect(ALLOWED, `getToolRiskLevel returned unexpected ${JSON.stringify(level)}`).toContain(level)
    }
    // 显式断言任何 toolName 不应返回 legacy 三档之一
    for (const legacy of ['low', 'medium', 'high'] as const) {
      const offenders = allTools.filter(name => getToolRiskLevel(name) === (legacy as unknown as ToolCardRiskLevel))
      expect(offenders, `'${legacy}' must never leak into ToolCardRiskLevel`).toEqual([])
    }
  })

  it('类型 ToolCardRiskLevel 仅四元组 (含 null)（type-level 断言）', () => {
    // 编译期断言：以下赋值应通过 typecheck
    const valid: ToolCardRiskLevel[] = ['safe', 'review', 'strict', null]
    expect(valid).toHaveLength(4)

    // 'low' 不应通过 typecheck（用 ts-expect-error 标记）
    // @ts-expect-error 'low' 不在 ToolCardRiskLevel 中（K8 词表收口）
    const _lowRejected: ToolCardRiskLevel = 'low'
    void _lowRejected

    // @ts-expect-error 'medium' 不在 ToolCardRiskLevel 中
    const _mediumRejected: ToolCardRiskLevel = 'medium'
    void _mediumRejected

    // @ts-expect-error 'high' 不在 ToolCardRiskLevel 中
    const _highRejected: ToolCardRiskLevel = 'high'
    void _highRejected
  })
})

describe('Terminal tool output extraction', () => {
  it('parses run_terminal_command camelCase JSON string output', () => {
    const data = extractTerminal(JSON.stringify({
      command: 'ls',
      stdout: 'conversations\nsites\nskills\n',
      stderr: '',
      exitCode: 0,
      durationMs: 20,
    }))

    expect(data).toMatchObject({
      kind: 'terminal',
      command: 'ls',
      stdout: 'conversations\nsites\nskills\n',
      stderr: '',
      exit_code: 0,
      duration_ms: 20,
    })
  })

  it('parses legacy snake_case terminal object output', () => {
    const data = extractTerminal({
      command: 'pwd',
      output: '/tmp\n',
      exit_code: 0,
      duration_ms: 12,
    })

    expect(data).toMatchObject({
      kind: 'terminal',
      command: 'pwd',
      stdout: '/tmp\n',
      exit_code: 0,
      duration_ms: 12,
    })
  })

  it('maps agent_session_id to terminal session_id for Agent transcript jump links', () => {
    const data = extractTerminal({
      stdout: 'total 8\n',
      exitCode: 0,
      agent_session_id: 'agent-space-1234',
    })

    expect(data).toMatchObject({
      kind: 'terminal',
      stdout: 'total 8\n',
      exit_code: 0,
      session_id: 'agent-space-1234',
    })
  })

  it('maps camelCase spaceId to terminal space_id', () => {
    const data = extractTerminal({
      stdout: 'ok\n',
      exitCode: 0,
      agent_session_id: 'agent-space-1234',
      spaceId: 'space-1',
    })

    expect(data).toMatchObject({
      kind: 'terminal',
      session_id: 'agent-space-1234',
      space_id: 'space-1',
    })
  })
})
