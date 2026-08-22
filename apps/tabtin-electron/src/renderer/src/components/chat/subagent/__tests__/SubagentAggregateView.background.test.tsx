import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SubagentRun } from '../../../../stores/chat/shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { selectedSpace: null }) => unknown) => selector({ selectedSpace: null }),
}))

vi.mock('@stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: (selector: (state: { subagentCancellingByRunId: Record<string, boolean>; cancellingBySessionId: Record<string, boolean>; cancelSubagentRun: () => void }) => unknown) =>
    selector({ subagentCancellingByRunId: {}, cancellingBySessionId: {}, cancelSubagentRun: vi.fn() }),
}))

vi.mock('../../hooks/useSubagentTemplateNames', () => ({
  useSubagentTemplateMeta: () => new Map(),
}))

vi.mock('../../model/useModelDisplayName', () => ({
  useModelDisplayName: (model?: string) => model ?? '',
}))

vi.mock('../../markdown/ShinyText', () => ({
  ShinyText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('../SubagentDisclosureContext', () => ({
  useSubagentDisclosure: () => ({
    expandedRunId: null,
    toggle: vi.fn(),
    collapse: vi.fn(),
  }),
}))

vi.mock('../SubagentStickyStackContext', () => ({
  SubagentStickyHeaderShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../SubagentInlineDetail', () => ({
  SubagentInlineDetail: () => null,
}))

import { SubagentAggregateView } from '../SubagentAggregateView'

function run(overrides: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return {
    subagentRunId: overrides.subagentRunId,
    status: 'completed',
    label: '后台调研',
    role: '调研员',
    ...overrides,
  } as SubagentRun
}

describe('SubagentAggregateView background marker', () => {
  it('后台子 Agent 行展示后台标记', () => {
    const { container } = render(
      <SubagentAggregateView
        sessionId="sess-1"
        runs={[run({ subagentRunId: 'run-background', background: true })]}
        expectedCount={1}
      />,
    )

    const row = container.querySelector('[data-testid="subagent-inline-row-run-background"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.dataset.subagentBackground).toBe('true')
    expect(row.textContent ?? '').toContain('后台')
  })
})
