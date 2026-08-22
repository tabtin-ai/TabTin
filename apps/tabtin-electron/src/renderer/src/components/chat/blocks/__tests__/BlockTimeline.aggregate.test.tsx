/**
 * BlockTimeline.aggregate.test.tsx — W3 聚合检测回归
 *
 * 验证 BlockTimeline 把"连续 ≥2 个 subagent tool_use block"自动聚合渲染
 * 为 SubagentAggregateView，而 0/1 个仍走单 SubagentProgressCard 路径，
 * 同时保证非 subagent block 的相对位置不被打乱（W3 核心不变量）。
 *
 * 拆两层断言：
 *   1. **纯函数层**（groupConsecutiveSubagentBlocks）：覆盖 0/1/2/3+/不连续/
 *      混杂等所有边角组合
 *   2. **组件渲染层**（BlockTimeline）：mount 后 DOM 查 aggregate vs single
 *      slot 是否符合预期
 */

import React from 'react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// 简化 react-i18next mock—— BlockTimeline / 子组件大量用 defaultValue 模式
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; duration?: string }) => {
      if (key.startsWith('toolName.')) {
        const name = key.slice('toolName.'.length)
        if (name && name !== 'unknown') return name
      }
      let dv = opts?.defaultValue ?? key
      if (opts?.count !== undefined) dv = dv.replace(/\{\{count\}\}/g, String(opts.count))
      if (opts?.duration !== undefined) dv = dv.replace(/\{\{duration\}\}/g, opts.duration)
      return dv
    },
    i18n: { language: 'zh-CN' },
  }),
}))

// 避开 SubagentAggregateGroup → useSubagentRuns → useChatRuntimeStore 重链路
// 在本测试里的复杂初始化：mock SubagentAggregateView 成 stub，专注验证
// BlockTimeline 的"聚合分组逻辑"本身，不验证 AggregateView 内部渲染（后者
// 由 SubagentAggregateView.test.tsx 单独覆盖）。
vi.mock('../../subagent/SubagentAggregateView', () => ({
  AGGREGATE_THRESHOLD: 2,
  SubagentAggregateView: ({ runs, sessionId }: { runs: unknown[]; sessionId: string | null }) => (
    <div
      data-testid="mock-subagent-aggregate"
      data-runs-count={runs.length}
      data-session-id={sessionId ?? ''}
    />
  ),
}))

// stub 子 Agent ToolUseBlockView 的 single 渲染——避免拉进整条 useSubagentRun
// 链路：单 subagent block 走 BlockTimelineItem，本测试只验证它仍然以 single
// 形态出现（即未被聚合掉）。
vi.mock('../dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../dispatcher')>('../dispatcher')
  return {
    ...actual,
    getBlockRenderer: () => {
      const StubRenderer: React.FC<{ entry: { block: unknown; block_id: string } }> = ({ entry }) => (
        <div
          data-testid="block-single-stub"
          data-block-type={(entry.block as { type?: string })?.type}
          data-block-name={(entry.block as { name?: string })?.name}
          data-block-id={entry.block_id}
        />
      )
      StubRenderer.displayName = 'StubRenderer'
      return StubRenderer
    },
  }
})

import {
  BlockTimeline,
  groupConsecutiveSubagentBlocks,
  collapseConsecutiveToolCards,
  isPrimaryToolOutcomeEntry,
} from '../BlockTimeline'
import type { ContentBlockEntry } from '../types'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'

/* ─── 工厂 ─────────────────────────────────────────────────────────── */

let _idSeq = 0
beforeEach(() => {
  useChatStore.setState({ messagesBySessionId: {} })
  useChatRuntimeStore.setState({ subagentRunsBySessionId: {} })
})

function makeEntry(opts: {
  type: string
  name?: string
  text?: string
  finalized?: boolean
  id?: string
  input?: Record<string, unknown>
}): ContentBlockEntry {
  _idSeq++
  const idx = _idSeq
  const block: Record<string, unknown> = {
    type: opts.type,
    id: opts.id ?? `blk-${idx}`,
  }
  if (opts.name) block.name = opts.name
  if (opts.type === 'tool_use') block.input = opts.input ?? {}
  if (opts.type === 'text') block.text = opts.text ?? `text ${idx}`
  return {
    index: idx,
    block_id: `blk-${idx}`,
    block: block as ContentBlockEntry['block'],
    finalized: opts.finalized ?? true,
    partial: false,
  }
}

function makeAgentEntry(): ContentBlockEntry {
  return makeEntry({ type: 'tool_use', name: 'agent', input: { prompt: '执行子任务' } })
}

function makeTextEntry(): ContentBlockEntry {
  return makeEntry({ type: 'text' })
}

function makeRegularToolEntry(name = 'read_file'): ContentBlockEntry {
  return makeEntry({ type: 'tool_use', name })
}

/* ─── 连续普通工具卡折叠（纯函数层） ─────────────────────────────────── */

describe('collapseConsecutiveToolCards — 纯函数（总是成组，结构稳定）', () => {
  const collapse = (blocks: ContentBlockEntry[]) =>
    collapseConsecutiveToolCards(groupConsecutiveSubagentBlocks(blocks))

  it('任意数量连续工具卡 → 总是归入 1 个 toolGroup（是否显示组头是渲染层的事）', () => {
    // 结构稳定不变量：不再「> 阈值才建组」——1/3/4 个都成组，成员 append-only、
    // key 稳定，追加新步不 remount 前面的卡。
    for (const len of [1, 2, 3, 4, 6]) {
      const blocks = Array.from({ length: len }, () => makeRegularToolEntry())
      const units = collapse(blocks)
      expect(units).toHaveLength(1)
      expect(units[0].kind).toBe('toolGroup')
      expect((units[0] as { entries: unknown[] }).entries).toHaveLength(len)
    }
  })

  it('text 打断连续段 → 两侧各自成组，不跨文本合并', () => {
    const blocks = [
      ...Array.from({ length: 4 }, () => makeRegularToolEntry()),
      makeTextEntry(),
      makeRegularToolEntry(),
      makeRegularToolEntry(),
    ]
    const units = collapse(blocks)
    // 前 4 个 → toolGroup；text → single；后 2 个 → 另一个 toolGroup
    expect(units.map((u) => u.kind)).toEqual(['toolGroup', 'single', 'toolGroup'])
  })

  it('DiffCard 工具作为主要结果留在主时间线，并打断两侧执行步骤分组', () => {
    const diff = makeRegularToolEntry('edit_file')
    const blocks = [
      makeRegularToolEntry(),
      makeEntry({ type: 'tool_result' }),
      diff,
      makeEntry({ type: 'tool_result' }),
      makeRegularToolEntry(),
    ]

    const units = collapse(blocks)

    expect(units.map((u) => u.kind)).toEqual([
      'toolGroup',
      'single',
      'single',
      'toolGroup',
    ])
    expect(units[1]).toEqual({ kind: 'single', entry: diff })
  })

  it('所有注册为 DiffCard 的编辑工具都沿用主要结果展示契约', () => {
    for (const toolName of ['edit_file', 'apply_patch', 'Edit', 'MultiEdit']) {
      const diff = makeRegularToolEntry(toolName)
      const units = collapse([makeRegularToolEntry(), diff, makeRegularToolEntry()])

      expect(units.map((u) => u.kind)).toEqual(['toolGroup', 'single', 'toolGroup'])
      expect(units[1]).toEqual({ kind: 'single', entry: diff })
    }
  })

  it('生图展示语义作为主要结果留在主时间线，不折叠进执行详情', () => {
    const media = makeRegularToolEntry('run_terminal_command')
    const isPrimary = (entry: ContentBlockEntry) => isPrimaryToolOutcomeEntry(
      entry,
      entry === media ? { kind: 'media_image_generation' } : undefined,
    )
    const units = collapseConsecutiveToolCards(
      groupConsecutiveSubagentBlocks([
        makeRegularToolEntry(),
        media,
        makeRegularToolEntry(),
      ]),
      undefined,
      isPrimary,
    )

    expect(units.map((unit) => unit.kind)).toEqual(['toolGroup', 'single', 'toolGroup'])
    expect(units[1]).toEqual({ kind: 'single', entry: media })
  })

  it('subagent 卡不被本折叠收编（由 subagentGroup 单独聚合）', () => {
    const blocks = Array.from({ length: 6 }, () => makeAgentEntry())
    const units = collapse(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
  })

  it('思考算入连续段：思考 + 工具卡交错 → 整体一个 toolGroup', () => {
    const blocks = [
      makeEntry({ type: 'thinking' }),
      makeRegularToolEntry(),
      makeEntry({ type: 'thinking' }),
      makeRegularToolEntry(),
    ]
    const units = collapse(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('toolGroup')
    expect((units[0] as { entries: unknown[] }).entries).toHaveLength(4)
  })

  it('空 text 不打断连续思考/工具段：多个 thinking+tool pair 合成一个 toolGroup', () => {
    const blocks = [
      makeEntry({ type: 'thinking' }),
      makeRegularToolEntry(),
      makeEntry({ type: 'text', text: '' }),
      makeEntry({ type: 'thinking' }),
      makeRegularToolEntry(),
      makeEntry({ type: 'text', text: '   ' }),
      makeEntry({ type: 'thinking' }),
      makeRegularToolEntry(),
    ]
    const units = collapse(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('toolGroup')
    expect((units[0] as { entries: unknown[] }).entries).toHaveLength(8)
  })

  it('text 仍打断连续段（思考算入、正文不算）', () => {
    const blocks = [
      makeEntry({ type: 'thinking' }),
      makeRegularToolEntry(),
      makeTextEntry(),
      ...Array.from({ length: 4 }, () => makeRegularToolEntry()),
    ]
    const units = collapse(blocks)
    // [think, tool] → toolGroup；text → single；后 4 个 → toolGroup
    expect(units.map((u) => u.kind)).toEqual(['toolGroup', 'single', 'toolGroup'])
  })

  it('历史交错：tool_use + tool_result 交替 → 结果块被吸入同组、不打断', () => {
    const blocks: ContentBlockEntry[] = []
    for (let k = 0; k < 4; k++) {
      blocks.push(makeRegularToolEntry())
      blocks.push(makeEntry({ type: 'tool_result' }))
    }
    const units = collapse(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('toolGroup')
    // 4 工具卡 + 4 结果块都被吸入同一组
    expect((units[0] as { entries: unknown[] }).entries).toHaveLength(8)
  })

  it('活跃尾步不再拆组：末尾进行中的步骤仍在组内（露出与否是渲染层能力）', () => {
    // 结构层不再区分「进行中尾步」——它留在组内，CollapsibleToolCardGroup 折叠时
    // 按 showLastWhenCollapsed 露出最后一条。避免尾步 settle 时换父 remount。
    const blocks = Array.from({ length: 5 }, () => makeRegularToolEntry())
    const units = collapse(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('toolGroup')
    expect((units[0] as { entries: unknown[] }).entries).toHaveLength(5)
  })
})

/* ─── 纯函数层 ─────────────────────────────────────────────────────── */

describe('groupConsecutiveSubagentBlocks — 纯函数', () => {
  it('空数组 → 空 units', () => {
    expect(groupConsecutiveSubagentBlocks([])).toEqual([])
  })

  it('0 个 subagent block → 所有 single', () => {
    const blocks = [makeTextEntry(), makeRegularToolEntry(), makeTextEntry()]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(3)
    expect(units.every((u) => u.kind === 'single')).toBe(true)
  })

  it('单个历史 subagent block → 保持 single，保留 archive reconcile', () => {
    const blocks = [makeTextEntry(), makeAgentEntry(), makeTextEntry()]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(3)
    expect(units.every((u) => u.kind === 'single')).toBe(true)
  })

  it('单个实时 subagent block → 已进入稳定聚合容器，追加第二个时不切换树形', () => {
    const groupForStreaming = groupConsecutiveSubagentBlocks as (
      blocks: ContentBlockEntry[],
      isInert?: (entry: ContentBlockEntry) => boolean,
      stabilizeSingleSubagent?: boolean,
    ) => ReturnType<typeof groupConsecutiveSubagentBlocks>
    const units = groupForStreaming([makeAgentEntry()], undefined, true)

    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
    if (units[0].kind === 'subagentGroup') expect(units[0].entries).toHaveLength(1)
  })

  it('2 个连续 subagent block → 1 个 group（恰好达阈值）', () => {
    const a1 = makeAgentEntry()
    const a2 = makeAgentEntry()
    const units = groupConsecutiveSubagentBlocks([a1, a2])
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
    if (units[0].kind === 'subagentGroup') {
      expect(units[0].entries).toHaveLength(2)
      expect(units[0].entries[0]).toBe(a1)
      expect(units[0].entries[1]).toBe(a2)
    }
  })

  it('3 个连续 subagent block → 1 个 group（全收纳）', () => {
    const blocks = [makeAgentEntry(), makeAgentEntry(), makeAgentEntry()]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
    if (units[0].kind === 'subagentGroup') {
      expect(units[0].entries).toHaveLength(3)
    }
  })

  it('5 个连续 subagent block + 前后包夹 text → text 仍占独立 single 槽', () => {
    const t1 = makeTextEntry()
    const agents = [makeAgentEntry(), makeAgentEntry(), makeAgentEntry(), makeAgentEntry(), makeAgentEntry()]
    const t2 = makeTextEntry()
    const blocks = [t1, ...agents, t2]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(3)
    expect(units[0].kind).toBe('single')
    expect(units[1].kind).toBe('subagentGroup')
    expect(units[2].kind).toBe('single')
    if (units[1].kind === 'subagentGroup') {
      expect(units[1].entries).toHaveLength(5)
    }
  })

  it('不连续的 subagent block（被 text 隔开）→ 各 single，不聚合', () => {
    const a1 = makeAgentEntry()
    const t = makeTextEntry()
    const a2 = makeAgentEntry()
    const units = groupConsecutiveSubagentBlocks([a1, t, a2])
    expect(units).toHaveLength(3)
    expect(units.every((u) => u.kind === 'single')).toBe(true)
  })

  it('被普通 tool_use（read_file）隔开 → 各 single，不聚合', () => {
    const a1 = makeAgentEntry()
    const rt = makeRegularToolEntry('read_file')
    const a2 = makeAgentEntry()
    const units = groupConsecutiveSubagentBlocks([a1, rt, a2])
    expect(units).toHaveLength(3)
    expect(units.every((u) => u.kind === 'single')).toBe(true)
  })

  it('多段连续：[agent, agent, text, agent, agent, agent] → group(2) + single(text) + group(3)', () => {
    const blocks = [
      makeAgentEntry(),
      makeAgentEntry(),
      makeTextEntry(),
      makeAgentEntry(),
      makeAgentEntry(),
      makeAgentEntry(),
    ]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(3)
    expect(units[0].kind).toBe('subagentGroup')
    expect(units[1].kind).toBe('single')
    expect(units[2].kind).toBe('subagentGroup')
    if (units[0].kind === 'subagentGroup') expect(units[0].entries).toHaveLength(2)
    if (units[2].kind === 'subagentGroup') expect(units[2].entries).toHaveLength(3)
  })

  it('一组 subagent + 末尾孤立 subagent：历史孤立项保持 single', () => {
    const blocks = [
      makeAgentEntry(),
      makeAgentEntry(),
      makeAgentEntry(),
      makeTextEntry(),
      makeAgentEntry(),
    ]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(3)
    expect(units[0].kind).toBe('subagentGroup')
    expect(units[1].kind).toBe('single')
    expect(units[2].kind).toBe('single')
  })

  it('SUBAGENT_TOOL_NAMES：agent / task / Task 三个别名都被识别', () => {
    const blocks = [
      makeEntry({ type: 'tool_use', name: 'agent', input: { prompt: '任务 A' } }),
      makeEntry({ type: 'tool_use', name: 'task', input: { prompt: '任务 B' } }),
      makeEntry({ type: 'tool_use', name: 'Task', input: { prompt: '任务 C' } }),
    ]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
    if (units[0].kind === 'subagentGroup') expect(units[0].entries).toHaveLength(3)
  })

  it('未 finalize 的 subagent block 也参与聚合（流式期间不闪屏切视图）', () => {
    const a1 = { ...makeAgentEntry(), finalized: false }
    const a2 = { ...makeAgentEntry(), finalized: false }
    const units = groupConsecutiveSubagentBlocks([a1, a2])
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
  })

  it('结果块夹在子代理 tool_use 之间仍聚合，且 entries 不含结果块（块级物化形态回归）', () => {
    // 回归（子代理串进主时间线）：块级时间线物化让 tool_result 继承并紧贴各
    // tool_use 的 arrival_seq → [agent, result, agent, result, agent, result]。
    // 结果块是惰性块（渲染 null），必须被跳过而不打断子代理连续段，否则聚合
    // 卡碎裂、子代理产物散进主流；同时结果块不能混进 entries（避免被
    // toolCallEntries 按 block_id 误当成一个 toolCall）。
    const a0 = makeAgentEntry()
    const a1 = makeAgentEntry()
    const a2 = makeAgentEntry()
    const blocks = [
      a0,
      makeEntry({ type: 'tool_result' }),
      a1,
      makeEntry({ type: 'tool_result' }),
      a2,
      makeEntry({ type: 'tool_result' }),
    ]
    const units = groupConsecutiveSubagentBlocks(blocks)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('subagentGroup')
    if (units[0].kind === 'subagentGroup') {
      expect(units[0].entries).toEqual([a0, a1, a2])
    }
  })

  it('结果块夹在单个子代理之后时保持 single，不混入结果块', () => {
    const a0 = makeAgentEntry()
    const blocks = [a0, makeEntry({ type: 'tool_result' })]
    const units = groupConsecutiveSubagentBlocks(blocks)
    // 单个 subagent（结果块跳过、不计数）→ 仅 1 个 single(agent)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('single')
    if (units[0].kind === 'single') expect(units[0].entry).toBe(a0)
  })
})

/* ─── 组件渲染层 ─────────────────────────────────────────────────── */

describe('BlockTimeline — 聚合渲染', () => {
  it('0 个 subagent block：渲染全部 single', () => {
    const blocks = [makeTextEntry(), makeRegularToolEntry(), makeTextEntry()]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
    expect(screen.getAllByTestId('block-single-stub').length).toBe(3)
  })

  it('1 个历史 subagent block：保持单卡路径以触发 archive reconcile', () => {
    const blocks = [makeTextEntry(), makeAgentEntry()]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
    expect(screen.getAllByTestId('block-single-stub').length).toBe(2)
  })

  it('1 个实时 subagent block：预先进入聚合容器，等待第二个任务追加', () => {
    render(
      <BlockTimeline
        blocks={[makeAgentEntry()]}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg
        isStreaming
      />,
    )

    expect(screen.getByTestId('mock-subagent-aggregate')).toBeTruthy()
    expect(screen.queryByTestId('block-single-stub')).toBeNull()
  })

  it('2 个连续 subagent block：渲染 1 个 AggregateView，无 single subagent', () => {
    const blocks = [makeAgentEntry(), makeAgentEntry()]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming
      />,
    )
    const aggs = screen.getAllByTestId('mock-subagent-aggregate')
    expect(aggs).toHaveLength(1)
    expect(screen.queryByTestId('block-single-stub')).toBeNull()
  })

  it('3 个连续 subagent block：渲染 1 个 AggregateView', () => {
    const blocks = [makeAgentEntry(), makeAgentEntry(), makeAgentEntry()]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming
      />,
    )
    expect(screen.getAllByTestId('mock-subagent-aggregate')).toHaveLength(1)
  })

  it('多段 [agent×2, text, agent×3]：渲染 2 个 AggregateView + 1 个 single（text）', () => {
    const blocks = [
      makeAgentEntry(),
      makeAgentEntry(),
      makeTextEntry(),
      makeAgentEntry(),
      makeAgentEntry(),
      makeAgentEntry(),
    ]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming
      />,
    )
    expect(screen.getAllByTestId('mock-subagent-aggregate')).toHaveLength(2)
    expect(screen.getAllByTestId('block-single-stub')).toHaveLength(1)
    // 顺序断言：DOM 中应是 [aggregate-wrapper, single-stub, aggregate-wrapper]
    //
    // 实际结构：
    //   <div data-testid="block-timeline">
    //     <div data-testid="block-subagent-aggregate"> [SubagentAggregateGroup wrapper]
    //       <div data-testid="mock-subagent-aggregate" />
    //     </div>
    //     <div data-testid="block-single-stub" />     [Renderer 直接渲染，ErrorBoundary
    //                                                  在无错时 return children]
    //     <div data-testid="block-subagent-aggregate">
    //       <div data-testid="mock-subagent-aggregate" />
    //     </div>
    //   </div>
    //
    // 取每个直接子的 data-testid——验证 W3 不变量"聚合不改变非 subagent
    // block 相对位置"，text 必须仍在两组 agent 中间。
    const root = document.querySelector('[data-testid="block-timeline"]')
    const directChildTestIds = Array.from(root?.children ?? []).map(
      (el) => el.getAttribute('data-testid'),
    )
    expect(directChildTestIds[0]).toBe('block-subagent-aggregate')
    expect(directChildTestIds[1]).toBe('block-single-stub')
    expect(directChildTestIds[2]).toBe('block-subagent-aggregate')
  })

  it('sessionId 透传到 AggregateView（drill-in 协议入参）', () => {
    const blocks = [makeAgentEntry(), makeAgentEntry()]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="my-session-id"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming
      />,
    )
    const agg = screen.getByTestId('mock-subagent-aggregate')
    expect(agg.getAttribute('data-session-id')).toBe('my-session-id')
  })

  it('不连续 subagent 不被聚合：[agent, text, agent] → 全 single', () => {
    const blocks = [makeAgentEntry(), makeTextEntry(), makeAgentEntry()]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming
      />,
    )
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
    expect(screen.getAllByTestId('block-single-stub')).toHaveLength(3)
  })

  it('流式末条工具组：当前回合中也立即显示合并头，避免连续步骤刷屏', () => {
    const blocks = Array.from({ length: 4 }, () => makeRegularToolEntry())
    // 全部 settle 但回合仍在流式：仍然显示合并头；高度动画在活跃 run 中关闭。
    useChatRuntimeStore.setState({
      toolEventsBySessionId: {
        'sess-1': blocks.map((entry, index) => ({
          id: (entry.block as { id: string }).id,
          toolName: `tool-${index}`,
          phase: 'end' as const,
          timestamp: index + 1,
        })),
      },
    })

    const { rerender } = render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg
        isStreaming
      />,
    )
    const streamingBody = screen.getByTestId('tool-card-group-panel-body')
    expect(streamingBody.getAttribute('data-layout-size')).toBe('false')
    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.queryAllByTestId('block-single-stub')).toHaveLength(0)
    expect(screen.queryByTestId('tool-card-group-held-steps')).toBeNull()

    rerender(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )
    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.getByTestId('tool-card-group-panel-body').getAttribute('data-layout-size')).toBe('false')
    expect(screen.queryByTestId('tool-card-group-held-steps')).toBeNull()
  })

  it('子 Agent push notification 不再渲染到对应 tool_use 后（完成气泡挂到后续 assistant）', () => {
    useChatStore.setState({
      messagesBySessionId: {
        'sess-1': [{
          id: 'push-user-1',
          role: 'user',
          content: [
            'A background sub-agent finished while you were doing other work:',
            '',
            '<task-notification kind="subagent-completed">',
            '<subagent-run-id>run-1</subagent-run-id>',
            '<label>查看磁盘使用情况</label>',
            '<status>completed</status>',
            '<duration-ms>2000</duration-ms>',
            '<parent-tool-call-id>toolu-df</parent-tool-call-id>',
            '<summary>磁盘空间充足</summary>',
            '</task-notification>',
          ].join('\n'),
          created_at: '2026-06-08T07:20:00.000Z',
          metadata: { triggered_by: 'push-notification' },
        } as never],
      },
    })
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        'sess-1': [{
          subagentRunId: 'run-1',
          parentToolCallId: 'toolu-df',
          status: 'completed',
          label: '查看磁盘使用情况',
        } as never],
      },
    })

    const blocks = [
      makeTextEntry(),
      makeEntry({
        type: 'tool_use',
        name: 'agent',
        id: 'toolu-df',
        input: { prompt: '查看磁盘使用情况' },
      }),
      makeTextEntry(),
    ]
    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="sess-1"
        messageId="msg-1"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )

    const root = screen.getByTestId('block-timeline')
    const directChildTestIds = Array.from(root.children).map(
      (el) => el.getAttribute('data-testid'),
    )
    expect(directChildTestIds).toEqual([
      'block-single-stub',
      'block-single-stub',
      'block-single-stub',
    ])
    expect(screen.queryByTestId('inline-push-notification')).toBeNull()
    expect(screen.queryByText('子 Agent 完成：查看磁盘使用情况')).toBeNull()
  })
})
