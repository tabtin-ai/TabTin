import { beforeEach, describe, expect, it, vi } from 'vitest'

const scheduleSeqGapSyncMock = vi.hoisted(() => vi.fn())
const isSessionBusyMock = vi.hoisted(() => vi.fn(() => false))
const useChatStoreMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({ syncSessionMessagesFromServer: vi.fn() })),
}))
vi.mock('../seqTracker', () => ({
  scheduleSeqGapSync: scheduleSeqGapSyncMock,
}))
vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: useChatStoreMock,
}))
vi.mock('@stores/chat/execution/sessionRunProjection', () => ({
  isSessionBusy: isSessionBusyMock,
}))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))

import { handleSeqGapControl } from '../observerSeqGap'

// ：seq 缺口**检测**已收口主进程（ConversationStreamAggregator）；渲染进程只保留
// 「收到主进程 control:'seq-gap' 帧 → 安排补拉」的执行侧（busy defer + debounce）。
describe('handleSeqGapControl（补拉执行侧）', () => {
  beforeEach(() => {
    scheduleSeqGapSyncMock.mockClear()
    isSessionBusyMock.mockReturnValue(false)
  })

  it('idle → 安排补拉（scheduleSeqGapSync）', () => {
    handleSeqGapControl('s1')
    expect(scheduleSeqGapSyncMock).toHaveBeenCalledTimes(1)
    expect(scheduleSeqGapSyncMock).toHaveBeenCalledWith('s1', expect.any(Function))
  })

  it('busy（run 进行中）→ defer，不安排全量 sync', () => {
    isSessionBusyMock.mockReturnValue(true)
    handleSeqGapControl('s1')
    expect(scheduleSeqGapSyncMock).not.toHaveBeenCalled()
  })

  it('安排的补拉回调触发 syncSessionMessagesFromServer', () => {
    const sync = vi.fn()
    useChatStoreMock.getState.mockReturnValue({ syncSessionMessagesFromServer: sync })
    handleSeqGapControl('s1')
    const scheduledFn = scheduleSeqGapSyncMock.mock.calls[0][1] as () => void
    scheduledFn()
    expect(sync).toHaveBeenCalledWith('s1')
  })
})
