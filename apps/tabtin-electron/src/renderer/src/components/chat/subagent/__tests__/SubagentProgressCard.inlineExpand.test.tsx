/**
 * SubagentProgressCard.inlineExpand.test.tsx — 兜底单卡「点行就地展开」回归
 *
 * 取代旧 SubagentProgressCard.drillInModal.test.tsx（2026-06-07 交互收口）：
 * registry 兜底单卡点击从「拉起 app 级执行流 modal（useSubagentFlowModalStore.open）」
 * 改为「在卡片正下方就地向下展开 SubagentDetailPane」，与对话内派发标记同一套交互。
 *
 * 覆盖：
 *   1. 点整行（header role=button）→ 卡片下方展开 inline 详情（带 runId）
 *   2. 再点整行 → 收起
 *   3. 点右侧 chevron 按钮（data-testid=subagent-card-drill-in）→ 展开
 *   4. completed / failed 状态都可展开
 *   5. sessionId 缺失（草稿态）→ chevron disabled、点击不展开
 *   6. unknown 状态 → chevron 按钮不渲染
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

const { speakerState } = vi.hoisted(() => ({
  speakerState: {
    speakersBySessionId: {} as Record<string, Record<string, unknown>>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      if (key.startsWith('toolName.')) {
        const name = key.slice('toolName.'.length)
        if (name && name !== 'unknown') return name
      }
      return opts?.defaultValue ?? key
    },
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return { useSpeakerRegistryStore: Object.assign(useStore, { getState: () => speakerState }) }
})
vi.mock('../../../../stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return { useSpeakerRegistryStore: Object.assign(useStore, { getState: () => speakerState }) }
})

// 展开后单卡会渲染 SubagentDetailPane（重依赖一堆 store + MessageList）。本测只验
// 展开/收起契约，把 Pane 换成轻量 stub，断言它收到正确 subagentRunId 即可。
vi.mock('../SubagentDetailPane', () => ({
  SubagentDetailPane: (props: { subagentRunId: string; compactHeader?: boolean }) => (
    <div
      data-testid="mock-detail-pane"
      data-run-id={props.subagentRunId}
      data-compact-header={props.compactHeader ? 'true' : 'false'}
    >
      detail
    </div>
  ),
}))

import { SubagentProgressCard } from '../SubagentProgressCard'

const SESSION_ID = 'session-inline'
const RUN_ID = 'run-inline-abc123'

beforeEach(() => {
  speakerState.speakersBySessionId = {}
})

function getRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="button"]') as HTMLElement | null
}
function getChevronButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('[data-testid="subagent-card-drill-in"]') as HTMLButtonElement | null
}
function queryDetail(container: HTMLElement) {
  return container.querySelector(`[data-testid="subagent-inline-detail-${RUN_ID}"]`)
}

describe('SubagentProgressCard 点行就地展开', () => {
  it('点整行（header）→ 卡片下方展开 inline 详情（带 runId）', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={SESSION_ID} task="跑工具" status="running" label="跑工具" />,
    )

    expect(queryDetail(container)).toBeNull()

    const row = getRow(container)
    expect(row).not.toBeNull()
    fireEvent.click(row!)

    const detail = queryDetail(container)
    expect(detail).not.toBeNull()
    expect(detail!.className).toContain('min-h-0')
    expect(detail!.className).toContain('overflow-visible')
    expect(detail!.className).not.toContain('max-h-')
    const header = container.querySelector('[role="button"]')
    // ：sticky 在外壳上，用 style.top / data-subagent-sticky-offset
    const stickyShell = header?.parentElement
    expect(stickyShell?.className).toContain('sticky')
    expect(stickyShell?.className).toContain('z-sticky')
    expect(stickyShell?.className).not.toContain('top-0')
    expect(stickyShell?.getAttribute('data-subagent-sticky-offset')).toBe('0')
    expect((stickyShell as HTMLElement | null)?.style.top).toBe('0px')
    expect(detail!.querySelector('[data-testid="mock-detail-pane"]')?.getAttribute('data-run-id')).toBe(RUN_ID)
    expect(detail!.querySelector('[data-testid="mock-detail-pane"]')?.getAttribute('data-compact-header')).toBe('true')
    expect(row!.getAttribute('aria-expanded')).toBe('true')
  })

  it('再点整行 → 收起', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={SESSION_ID} task="跑工具" status="running" label="跑工具" />,
    )
    const row = getRow(container)!
    fireEvent.click(row)
    expect(queryDetail(container)).not.toBeNull()
    fireEvent.click(row)
    expect(queryDetail(container)).toBeNull()
  })

  it('点右侧 chevron 按钮 → 展开（含 runId）', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={SESSION_ID} task="跑工具" status="running" label="跑工具" />,
    )
    const button = getChevronButton(container)
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    expect(queryDetail(container)).not.toBeNull()
  })

  it('completed 状态可展开', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={SESSION_ID} task="done" status="completed" />,
    )
    fireEvent.click(getChevronButton(container)!)
    expect(queryDetail(container)).not.toBeNull()
  })

  it('failed 状态可展开', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={SESSION_ID} task="fail" status="failed" />,
    )
    fireEvent.click(getChevronButton(container)!)
    expect(queryDetail(container)).not.toBeNull()
  })

  it('sessionId 缺失（草稿态）→ chevron disabled、点击不展开', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={null} task="no session" status="running" />,
    )
    const button = getChevronButton(container)
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(true)
    fireEvent.click(button!)
    expect(queryDetail(container)).toBeNull()
  })

  it('unknown 状态 → chevron 按钮不渲染（没东西可看）', () => {
    const { container } = render(
      <SubagentProgressCard subagentRunId={RUN_ID} sessionId={SESSION_ID} task="unknown" status="unknown" />,
    )
    expect(getChevronButton(container)).toBeNull()
  })
})
