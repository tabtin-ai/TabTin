import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  cancelFeishuImportTable: vi.fn(),
  getFeishuImportTask: vi.fn(),
  skipFeishuImportTable: vi.fn(),
  startFeishuImport: vi.fn(),
}))

const toastMock = vi.hoisted(() => vi.fn())

vi.mock('@components/ui', () => ({ toast: toastMock }))
vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  },
}))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))
vi.mock('@stores/useCollections', () => ({
  useCollections: {
    getState: () => ({
      load: vi.fn().mockResolvedValue(undefined),
      loadOrganization: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))
vi.mock('@stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: () => ({ load: vi.fn().mockResolvedValue(undefined) }),
  },
}))
vi.mock('../feishuApi', () => ({
  ...apiMocks,
  extractImportedTableIds: vi.fn(() => []),
  getFeishuDisplayName: (_kind: string, name: unknown) => String(name || ''),
  isFeishuImportTerminalFailure: (status: string) => ['failed', 'error'].includes(status.toLowerCase()),
  isFeishuImportTerminalSuccess: (status: string) => ['completed', 'success', 'done'].includes(status.toLowerCase()),
}))

import { useFeishuImportJobStore } from '../useFeishuImportJobStore'
import { resetSessionState } from '@stores/sessionReset'

const input = {
  organizationId: 'org-1',
  spaceId: 'space-1',
  tables: [
    { app_token: 'app-1', table_id: 'table-1', name: '表一' },
    { app_token: 'app-1', table_id: 'table-2', name: '表二' },
  ],
  items: [
    { app_token: 'app-1', table_id: 'table-1', name: '表一' },
    { app_token: 'app-1', table_id: 'table-2', name: '表二' },
  ],
}

describe('useFeishuImportJobStore timeout actions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useFeishuImportJobStore.getState().dismiss()
    apiMocks.startFeishuImport.mockResolvedValue({ task_id: 'task-1' })
    apiMocks.getFeishuImportTask.mockResolvedValue({
      status: 'running',
      result: { phase: 'phase_a' },
    })
    apiMocks.skipFeishuImportTable.mockResolvedValue({ ok: true })
    apiMocks.cancelFeishuImportTable.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    useFeishuImportJobStore.getState().dismiss()
    vi.useRealTimers()
  })

  it('keeps the server task actionable after polling times out', async () => {
    const startPromise = useFeishuImportJobStore.getState().startJob(input)
    await vi.advanceTimersByTimeAsync(0)
    useFeishuImportJobStore.getState().toggleCollapsed()
    expect(useFeishuImportJobStore.getState().collapsed).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    const timedOut = useFeishuImportJobStore.getState()
    expect(timedOut.errorMessage).toContain('导入超时')
    expect(timedOut.collapsed).toBe(false)
    expect(timedOut.taskId).toBe('task-1')
    expect(timedOut.activeBatchId).not.toBeNull()

    const [running, pending] = timedOut.items
    await useFeishuImportJobStore.getState().skipItem(running.key)
    await useFeishuImportJobStore.getState().cancelItem(pending.key)

    expect(apiMocks.skipFeishuImportTable).toHaveBeenCalledWith('task-1', {
      app_token: 'app-1',
      table_id: 'table-1',
    })
    expect(apiMocks.cancelFeishuImportTable).toHaveBeenCalledWith('task-1', {
      app_token: 'app-1',
      table_id: 'table-2',
    })
    expect(useFeishuImportJobStore.getState().items.map((item) => item.status)).toEqual([
      'skipped',
      'cancelled',
    ])

    apiMocks.getFeishuImportTask.mockResolvedValueOnce({
      status: 'success',
      result: {
        phase: 'done',
        skipped_keys: ['app-1:table-1'],
        cancelled_keys: ['app-1:table-2'],
      },
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await startPromise

    const settled = useFeishuImportJobStore.getState()
    expect(settled.status).toBe('done')
    expect(settled.items.map((item) => item.status)).toEqual(['skipped', 'cancelled'])
  })

  it('restores skip and cancel actions when requests fail so the user can retry', async () => {
    const startPromise = useFeishuImportJobStore.getState().startJob(input)
    await vi.advanceTimersByTimeAsync(0)
    const [running, pending] = useFeishuImportJobStore.getState().items

    apiMocks.skipFeishuImportTable.mockRejectedValueOnce(new Error('network unavailable'))
    await useFeishuImportJobStore.getState().skipItem(running.key)

    expect(useFeishuImportJobStore.getState().items[0].status).toBe('running')
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      description: 'network unavailable',
      variant: 'destructive',
    }))

    await useFeishuImportJobStore.getState().skipItem(running.key)
    expect(apiMocks.skipFeishuImportTable).toHaveBeenCalledTimes(2)
    expect(useFeishuImportJobStore.getState().items[0].status).toBe('skipped')

    apiMocks.cancelFeishuImportTable.mockRejectedValueOnce(new Error('service unavailable'))
    await useFeishuImportJobStore.getState().cancelItem(pending.key)

    expect(useFeishuImportJobStore.getState().items[1].status).toBe('pending')
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      description: 'service unavailable',
      variant: 'destructive',
    }))

    await useFeishuImportJobStore.getState().cancelItem(pending.key)
    expect(apiMocks.cancelFeishuImportTable).toHaveBeenCalledTimes(2)
    expect(useFeishuImportJobStore.getState().items[1].status).toBe('cancelled')

    useFeishuImportJobStore.getState().dismiss()
    await vi.advanceTimersByTimeAsync(1_500)
    await startPromise
  })

  it('clears an import failure when the session is reset', async () => {
    useFeishuImportJobStore.setState({
      activeBatchId: 'batch-1',
      taskId: 'task-1',
      items: [{
        key: 'item-1',
        tableKey: 'app-1:table-1',
        batchId: 'batch-1',
        name: '表一',
        status: 'error',
      }],
      status: 'error',
      errorMessage: 'network unavailable',
    })

    await resetSessionState('token_refresh_failed')

    expect(useFeishuImportJobStore.getState()).toMatchObject({
      batches: [],
      activeBatchId: null,
      taskId: null,
      items: [],
      status: 'idle',
      errorMessage: null,
    })
  })
})
