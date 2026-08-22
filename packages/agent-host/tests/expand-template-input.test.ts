/**
 * ：模板展开的 tool_domains 三态语义回归。
 *
 * 与 runtime `tool_domains` 契约一致：
 *   undefined = 动态继承父工具；[] = 不给任何工具；非空 = 显式子集。
 * 旧实现在模板路径破坏了前两态：[] 被反转成父工具全集、undefined 被物化成
 * 冻结的显式白名单（父工具变化后不再跟随）。
 */
import { describe, expect, it } from 'vitest'
import { expandTemplateIntoAgentInput } from '../src/configuration/expand-template-input.js'
import type {
  SubAgentTemplateSnapshot,
  TemplateSnapshotsGetter,
} from '../src/configuration/subagent-template-resolver.js'

const PARENT_TOOLS = ['read_file', 'grep_search', 'run_terminal_command', 'skills_read']

function snapshotsWith(overrides: Partial<SubAgentTemplateSnapshot>): TemplateSnapshotsGetter {
  const snapshot: SubAgentTemplateSnapshot = {
    id: 'tpl-1',
    name: '调研模板',
    description: '',
    systemPrompt: '',
    subagentType: 'explore',
    allowedTools: [],
    deniedTools: [],
    modelId: '',
    thinkingLevel: '',
    defaultMode: 'wait',
    version: 1,
    isEnabled: true,
    ...overrides,
  }
  return async () => new Map([[snapshot.id, snapshot]])
}

async function expand(input: Record<string, unknown>, snapshots: TemplateSnapshotsGetter) {
  return expandTemplateIntoAgentInput(input, snapshots, PARENT_TOOLS)
}

describe('expandTemplateIntoAgentInput tool_domains 三态', () => {
  it('无模板约束 + 未传 → 不物化白名单（保持动态继承）', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1' },
      snapshotsWith({}),
    )
    expect('tool_domains' in input).toBe(false)
  })

  it('无模板约束 + 空数组 → 保持 []（不给任何工具），不得反转成父全集', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1', tool_domains: [] },
      snapshotsWith({}),
    )
    expect(input.tool_domains).toEqual([])
  })

  it('无模板约束 + 显式子集 → 原样透传', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1', tool_domains: ['read_file'] },
      snapshotsWith({}),
    )
    expect(input.tool_domains).toEqual(['read_file'])
  })

  it('模板 allow 约束 + 未传 → 以父工具快照为基础过滤', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1' },
      snapshotsWith({ allowedTools: ['read_file', 'grep_search'] }),
    )
    expect(input.tool_domains).toEqual(['read_file', 'grep_search'])
  })

  it('模板 allow 约束 + 显式子集 → 只保留交集', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1', tool_domains: ['read_file', 'skills_read'] },
      snapshotsWith({ allowedTools: ['read_file', 'grep_search'] }),
    )
    expect(input.tool_domains).toEqual(['read_file'])
  })

  it('模板 deny 约束 + 未传 → 从父工具快照中排除 denied', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1' },
      snapshotsWith({ deniedTools: ['run_terminal_command'] }),
    )
    expect(input.tool_domains).toEqual(['read_file', 'grep_search', 'skills_read'])
  })

  it('模板 deny 约束 + 显式子集 → 过滤后可为 []（不回退全集）', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1', tool_domains: ['run_terminal_command'] },
      snapshotsWith({ deniedTools: ['run_terminal_command'] }),
    )
    expect(input.tool_domains).toEqual([])
  })

  it('模板 allow/deny 约束 + 显式空数组 → 保持无工具，不回退父工具快照', async () => {
    const { input } = await expand(
      { prompt: 'x', template_id: 'tpl-1', tool_domains: [] },
      snapshotsWith({ allowedTools: ['read_file'], deniedTools: ['run_terminal_command'] }),
    )
    expect(input.tool_domains).toEqual([])
  })

  it('模板未命中 → 剥离 template_id，但保留调用方 tool_domains 语义', async () => {
    const { input } = await expandTemplateIntoAgentInput(
      { prompt: 'x', template_id: 'missing', tool_domains: [] },
      async () => new Map(),
      PARENT_TOOLS,
    )
    expect(input).toEqual({ prompt: 'x', tool_domains: [] })
  })
})
