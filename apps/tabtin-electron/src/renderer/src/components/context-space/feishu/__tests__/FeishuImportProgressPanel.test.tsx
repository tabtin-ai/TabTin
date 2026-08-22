import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

import { FeishuImportProgressPanel } from '../FeishuImportProgressPanel'
import { useFeishuImportJobStore } from '../useFeishuImportJobStore'

function seedState(items: Array<{
  key: string
  tableKey: string
  batchId: string
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled'
}>) {
  act(() => {
    useFeishuImportJobStore.setState({
      batches: [],
      activeBatchId: null,
      taskId: 'task-1',
      taskPhase: 'phase_a',
      items,
      status: 'running',
      errorMessage: '导入超时，可跳过当前项或取消等待项',
      collapsed: false,
      pollGeneration: 0,
      pumping: false,
    })
  })
}

describe('FeishuImportProgressPanel', () => {
  afterEach(() => {
    act(() => {
      useFeishuImportJobStore.getState().dismiss()
    })
  })

  it('shows close button when the queue only contains terminal items', () => {
    seedState([
      {
        key: 'item-1',
        tableKey: 'app-1:table-1',
        batchId: 'batch-1',
        name: '表一',
        status: 'done',
      },
      {
        key: 'item-2',
        tableKey: 'app-1:table-2',
        batchId: 'batch-1',
        name: '表二',
        status: 'skipped',
      },
      {
        key: 'item-3',
        tableKey: 'app-1:table-3',
        batchId: 'batch-1',
        name: '表三',
        status: 'cancelled',
      },
    ])

    render(<FeishuImportProgressPanel />)

    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
  })

  it('keeps close button hidden while non-terminal items remain', () => {
    seedState([
      {
        key: 'item-1',
        tableKey: 'app-1:table-1',
        batchId: 'batch-1',
        name: '表一',
        status: 'pending',
      },
      {
        key: 'item-2',
        tableKey: 'app-1:table-2',
        batchId: 'batch-1',
        name: '表二',
        status: 'done',
      },
    ])

    render(<FeishuImportProgressPanel />)

    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull()
  })
})
