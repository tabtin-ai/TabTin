import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ipcListeners,
  inheritViewControl,
  getTabByView,
  isOrganizationTab,
  sendResourceOpenFallback,
  rendererSend,
} = vi.hoisted(() => ({
  ipcListeners: new Map<string, Array<(...args: any[]) => void>>(),
  inheritViewControl: vi.fn(),
  getTabByView: vi.fn(() => 'org-tab-1'),
  isOrganizationTab: vi.fn(() => true),
  sendResourceOpenFallback: vi.fn(() => true),
  rendererSend: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: any[]) => void) => {
      const list = ipcListeners.get(channel) ?? []
      list.push(handler)
      ipcListeners.set(channel, list)
    }),
    removeListener: vi.fn((channel: string, handler: (...args: any[]) => void) => {
      const list = ipcListeners.get(channel) ?? []
      ipcListeners.set(channel, list.filter((candidate) => candidate !== handler))
    }),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../../browser-tab-lock/browserTabInputLock', () => ({
  inheritViewControl: (...args: unknown[]) => inheritViewControl(...args),
}))

vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({ getTabByView, isOrganizationTab }),
}))

vi.mock('../../resource-open-fallback', () => ({
  sendResourceOpenFallback: (...args: unknown[]) => sendResourceOpenFallback(...args),
}))

import { openUrlInWorkspaceTab } from '../open-in-tab'

function emitFrom(
  sender: { id: number; send: ReturnType<typeof vi.fn> },
  channel: string,
  ...args: any[]
): void {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({ sender }, ...args)
  }
}

function emit(channel: string, ...args: any[]): void {
  emitFrom({ id: 101, send: rendererSend }, channel, ...args)
}

function getLastRequestId(mainWindow: typeof windowStub): string {
  const payload = mainWindow.webContents.send.mock.calls
    .findLast((call) => call[0] === 'workspace:create-view-requested')?.[1]
  expect(payload?.requestId).toBeTruthy()
  return payload.requestId
}

const windowStub = {
  isDestroyed: vi.fn(() => false),
  webContents: {
    id: 101,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  },
}

function expectTerminalCleanup(): void {
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcListeners.get('workspace:create-view:ack') ?? []).toHaveLength(0)
  expect(ipcListeners.get('workspace:create-view:created') ?? []).toHaveLength(0)
}

describe('open-in-tab 控制态继承', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcListeners.clear()
    vi.clearAllMocks()
    windowStub.isDestroyed.mockReturnValue(false)
    windowStub.webContents.isDestroyed.mockReturnValue(false)
    getTabByView.mockImplementation((viewId: string) => {
      if (viewId === 'view-source' || viewId.startsWith('view-')) return 'org-tab-1'
      return null
    })
    isOrganizationTab.mockReturnValue(true)
  })

  afterEach(() => {
    expectTerminalCleanup()
    vi.useRealTimers()
  })

  it('renderer 回传 created 后按 requestId 触发 inheritViewControl(source, new)', () => {
    const result = openUrlInWorkspaceTab({
      url: 'https://example.com/article',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    expect(result).toBe('sent')

    emit('workspace:create-view:created', {
      requestId: getLastRequestId(windowStub),
      viewId: 'view-new',
    })

    expect(inheritViewControl).toHaveBeenCalledWith('view-source', 'view-new')
    expect(windowStub.webContents.send).toHaveBeenCalledWith('workspace:create-view:inherited', {
      requestId: expect.any(String),
      viewId: 'view-new',
    })
    expect(rendererSend).not.toHaveBeenCalled()
    expectTerminalCleanup()
  })

  it('ack 先到时仅清 ack listener，created 后仍继承', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/ack-before-created',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)

    emit('workspace:create-view:ack', { requestId })
    expect(ipcListeners.get('workspace:create-view:ack') ?? []).toHaveLength(0)
    expect(ipcListeners.get('workspace:create-view:created') ?? []).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    emit('workspace:create-view:created', { requestId, viewId: 'view-new' })

    expect(inheritViewControl).toHaveBeenCalledWith('view-source', 'view-new')
    expectTerminalCleanup()
  })

  it('requestId 不匹配时保留 terminal listener 等待正确回传', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/mismatched-created',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)

    emit('workspace:create-view:created', { requestId: 'wrong', viewId: 'view-new' })

    expect(inheritViewControl).not.toHaveBeenCalled()
    expect(ipcListeners.get('workspace:create-view:created') ?? []).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    emit('workspace:create-view:created', { requestId, viewId: 'view-new' })
    expect(inheritViewControl).toHaveBeenCalledWith('view-source', 'view-new')
  })

  it('requestId 命中但缺少有效 viewId 时按 terminal 消息完整清理', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/invalid-created',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)

    emit('workspace:create-view:created', { requestId, viewId: '' })

    expect(inheritViewControl).not.toHaveBeenCalled()
    expect(windowStub.webContents.send).not.toHaveBeenCalledWith(
      'workspace:create-view:inherited',
      expect.anything(),
    )
    expectTerminalCleanup()
  })

  it('慢创建超过旧去重窗口时重复请求仍 dedupe，旧 created 不丢继承', () => {
    const url = 'https://example.com/slow-create'
    openUrlInWorkspaceTab({ url, viewId: 'view-source', mainWindow: windowStub as never })
    const requestId = getLastRequestId(windowStub)

    vi.advanceTimersByTime(1001)
    const duplicate = openUrlInWorkspaceTab({
      url,
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })

    expect(duplicate).toBe('deduped')
    expect(windowStub.webContents.send).toHaveBeenCalledTimes(1)
    expect(ipcListeners.get('workspace:create-view:created') ?? []).toHaveLength(1)

    emit('workspace:create-view:created', { requestId, viewId: 'view-created' })

    expect(inheritViewControl).toHaveBeenCalledWith('view-source', 'view-created')
    expectTerminalCleanup()
  })

  it('created 后立即释放 timer、两个 listener 和去重槽位', () => {
    const url = 'https://example.com/release-slot'
    openUrlInWorkspaceTab({ url, viewId: 'view-source', mainWindow: windowStub as never })
    const firstRequestId = getLastRequestId(windowStub)

    emit('workspace:create-view:created', { requestId: firstRequestId, viewId: 'view-first' })
    expectTerminalCleanup()

    expect(openUrlInWorkspaceTab({
      url,
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })).toBe('sent')
    expect(windowStub.webContents.send.mock.calls.filter(
      (call) => call[0] === 'workspace:create-view-requested',
    )).toHaveLength(2)

    emit('workspace:create-view:created', {
      requestId: getLastRequestId(windowStub),
      viewId: 'view-second',
    })
  })

  it('TTL 到期时同时清理 ack 和 created listener', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/ttl',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)

    vi.advanceTimersByTime(5000)
    emit('workspace:create-view:created', { requestId, viewId: 'view-late' })

    expect(inheritViewControl).not.toHaveBeenCalled()
    expectTerminalCleanup()
  })

  it('main 仅在 inheritViewControl 完成后发送确认', () => {
    const order: string[] = []
    inheritViewControl.mockImplementation(() => {
      order.push('inherit')
    })
    windowStub.webContents.send.mockImplementation((channel: string) => {
      if (channel === 'workspace:create-view:inherited') order.push('confirm')
    })
    openUrlInWorkspaceTab({
      url: 'https://example.com/ordered-confirm',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })

    emit('workspace:create-view:created', {
      requestId: getLastRequestId(windowStub),
      viewId: 'view-new',
    })

    expect(order).toEqual(['inherit', 'confirm'])
  })

  it('新 view 映射稍后就绪时在 main TTL 内重试并完成继承', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/delayed-mapping',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)
    getTabByView.mockImplementation((viewId: string) => (
      viewId === 'view-source' ? 'org-tab-1' : null
    ))

    emit('workspace:create-view:created', { requestId, viewId: 'view-new' })
    expect(inheritViewControl).not.toHaveBeenCalled()

    getTabByView.mockReturnValue('org-tab-1')
    vi.advanceTimersByTime(25)

    expect(inheritViewControl).toHaveBeenCalledWith('view-source', 'view-new')
    expect(windowStub.webContents.send).toHaveBeenCalledWith(
      'workspace:create-view:inherited',
      { requestId, viewId: 'view-new' },
    )
  })

  it('拒绝伪造 sender，且保留请求等待正确 renderer', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/forged-sender',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)

    emitFrom(
      { id: 999, send: vi.fn() },
      'workspace:create-view:created',
      { requestId, viewId: 'view-new' },
    )

    expect(inheritViewControl).not.toHaveBeenCalled()
    expect(windowStub.webContents.send).not.toHaveBeenCalledWith(
      'workspace:create-view:inherited',
      expect.anything(),
    )

    emit('workspace:create-view:created', { requestId, viewId: 'view-new' })
    expect(inheritViewControl).toHaveBeenCalledWith('view-source', 'view-new')
  })

  it('拒绝跨 workspace 或未登记目标 view，不继承也不确认', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/cross-workspace',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)
    getTabByView.mockImplementation((viewId: string) => (
      viewId === 'view-source' ? 'org-tab-1' : 'org-tab-other'
    ))

    emit('workspace:create-view:created', { requestId, viewId: 'view-cross' })

    expect(inheritViewControl).not.toHaveBeenCalled()
    expect(windowStub.webContents.send).not.toHaveBeenCalledWith(
      'workspace:create-view:inherited',
      expect.anything(),
    )

    vi.advanceTimersByTime(5000)
  })

  it('拒绝 mainWindow 销毁后的 created 消息', () => {
    openUrlInWorkspaceTab({
      url: 'https://example.com/destroyed-window',
      viewId: 'view-source',
      mainWindow: windowStub as never,
    })
    const requestId = getLastRequestId(windowStub)
    windowStub.isDestroyed.mockReturnValue(true)

    emit('workspace:create-view:created', { requestId, viewId: 'view-new' })

    expect(inheritViewControl).not.toHaveBeenCalled()
    expect(windowStub.webContents.send).not.toHaveBeenCalledWith(
      'workspace:create-view:inherited',
      expect.anything(),
    )

    vi.advanceTimersByTime(5000)
  })
})
