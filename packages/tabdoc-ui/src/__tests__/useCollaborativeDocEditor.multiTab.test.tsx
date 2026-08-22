/**
 * @vitest-environment jsdom
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollaborativeDocEditor } from '../useCollaborativeDocEditor'
import { resetDocMultiTabPresenceForTest } from '../docMultiTabPresence'

const {
  toastMock,
  acknowledgeLongOfflineMock,
  collabProviderMock,
  eventStreamHandlerRef,
  eventStreamSubscribeMock,
  autoSaveControllerMock,
  recoverFromExternalUpdateMock,
  markAwaitingRemoteApplyMock,
  configStub,
  docEditorStub,
} = vi.hoisted(() => {
  const eventStreamHandlerRef = { current: null as ((event: unknown) => void) | null }
  const eventStreamSubscribeMock = vi.fn(
    (_documentId: string, handler: (event: unknown) => void) => {
      eventStreamHandlerRef.current = handler
      return { status: 'connected', unsubscribe: vi.fn() }
    },
  )
  const autoSaveControllerMock = {
    isDirty: vi.fn(() => false),
    isSaving: vi.fn(() => false),
  }
  const recoverFromExternalUpdateMock = vi.fn(async () => ({ action: 'resolved' as const }))
  const markAwaitingRemoteApplyMock = vi.fn()

  return {
    toastMock: vi.fn(),
    acknowledgeLongOfflineMock: vi.fn(),
    collabProviderMock: vi.fn(),
    eventStreamHandlerRef,
    eventStreamSubscribeMock,
    autoSaveControllerMock,
    recoverFromExternalUpdateMock,
    markAwaitingRemoteApplyMock,
    configStub: {
      auth: {
        getCurrentUser: () => ({ id: 'u-1', nickname: 'User One' }),
        getAccessToken: vi.fn(() => Promise.resolve('jwt-token')),
        refreshAccessToken: vi.fn(() => Promise.resolve('jwt-token-refreshed')),
      },
      collab: {
        enabled: true,
        wsUrl: 'ws://localhost:4100/collaboration',
      },
      eventStream: { subscribe: eventStreamSubscribeMock },
    },
    docEditorStub: {
      currentDocument: null,
      currentRevision: null,
      saveState: 'idle' as const,
      saveMessage: '',
      syncState: 'synced' as const,
      isLoadingDetail: false,
      initialPmJson: {},
      initialMarkdown: '',
      editorKey: 1,
      draftRef: { current: { pmJson: {}, markdown: '', plaintext: '' } },
      baseVersionRef: { current: null },
      baseUpdatedAtRef: { current: null },
      activeDocumentIdRef: { current: null },
      autoSaveControllerRef: { current: autoSaveControllerMock },
      handleEditorUpdate: vi.fn(),
      updateDraftOnly: vi.fn(),
      manualSave: vi.fn(),
      patchCurrentDocument: vi.fn(),
      recoverFromExternalUpdate: recoverFromExternalUpdateMock,
      markAwaitingRemoteApply: markAwaitingRemoteApplyMock,
      markDocumentSynced: vi.fn(),
      loadError: null,
      retryLoad: vi.fn(),
    },
  }
})

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: toastMock,
}))

vi.mock('@tabtin/doc-editor', () => ({
  recordProbeEvent: vi.fn(),
}))

vi.mock('../useDocEditor', () => ({
  useDocEditor: () => docEditorStub,
}))

vi.mock('../TabDocEditorConfigContext', () => ({
  useTabDocEditorConfigOptional: () => configStub,
}))

vi.mock('@tabtin/collab-core', () => ({
  useCollabProvider: (options: unknown) => {
    collabProviderMock(options)
    return {
      status: 'disconnected',
      peers: [],
      provider: null,
      ydoc: null,
      forceCloseMessage: null,
      lastError: null,
      disconnectTimedOut: false,
      storeFailed: null,
      longOfflineDetected: false,
      syncMode: 'legacy',
      readOnly: false,
      canEdit: true,
      acknowledgeLongOffline: acknowledgeLongOfflineMock,
    }
  },
  CollabStatus: {
    SYNCED: 'synced',
    SYNCING: 'syncing',
    DISCONNECTED: 'disconnected',
  },
  shouldFallbackToLegacy: () => true,
  getUserColor: () => '#3b82f6',
}))

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []

  readonly name: string
  readonly postMessage = vi.fn((data: unknown) => {
    for (const peer of MockBroadcastChannel.instances) {
      if (peer === this || peer.closed || peer.name !== this.name) continue
      peer.onmessage?.({ data } as MessageEvent)
    }
  })
  readonly close = vi.fn(() => {
    this.closed = true
  })

  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }

  static reset(): void {
    MockBroadcastChannel.instances = []
  }
}

function Harness({ documentId, version }: { documentId: string; version: string }) {
  useCollaborativeDocEditor({
    documentId,
    t: (key, options) => `${options?.defaultValue ?? key}:${version}`,
  })
  return null
}

describe('useCollaborativeDocEditor multi-tab presence', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    toastMock.mockClear()
    acknowledgeLongOfflineMock.mockClear()
    collabProviderMock.mockClear()
    eventStreamHandlerRef.current = null
    eventStreamSubscribeMock.mockClear()
    autoSaveControllerMock.isDirty.mockReset().mockReturnValue(false)
    autoSaveControllerMock.isSaving.mockReset().mockReturnValue(false)
    recoverFromExternalUpdateMock.mockReset().mockResolvedValue({ action: 'resolved' })
    markAwaitingRemoteApplyMock.mockClear()
    docEditorStub.patchCurrentDocument.mockClear()
    docEditorStub.retryLoad.mockClear()
    configStub.auth.getAccessToken.mockClear()
    configStub.auth.getAccessToken.mockImplementation(() => Promise.resolve('jwt-token'))
    configStub.auth.refreshAccessToken.mockClear()
    configStub.auth.refreshAccessToken.mockImplementation(() => Promise.resolve('jwt-token-refreshed'))
    Object.assign(docEditorStub, {
      currentDocument: null,
      saveState: 'idle',
      isLoadingDetail: false,
      loadError: null,
    })
    MockBroadcastChannel.reset()
    resetDocMultiTabPresenceForTest()
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => {
      root.unmount()
    })
    container.remove()
    resetDocMultiTabPresenceForTest()
    vi.unstubAllGlobals()
  })

  it('StrictMode 双挂载时不应误创建第二个 channel 或弹出误报 toast', () => {
    flushSync(() => {
      root.render(
        <React.StrictMode>
          <Harness documentId="doc-1" version="v1" />
        </React.StrictMode>,
      )
    })

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    expect(MockBroadcastChannel.instances[0]?.postMessage).toHaveBeenCalledTimes(1)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('rerender 产生新的 t 回调时不应重新开启多标签检测 session', () => {
    flushSync(() => {
      root.render(<Harness documentId="doc-1" version="v1" />)
    })

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    expect(MockBroadcastChannel.instances[0]?.postMessage).toHaveBeenCalledTimes(1)

    flushSync(() => {
      root.render(<Harness documentId="doc-1" version="v2" />)
    })

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    expect(MockBroadcastChannel.instances[0]?.postMessage).toHaveBeenCalledTimes(1)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('文档详情未成功加载时不启动协作连接', async () => {
    Object.assign(docEditorStub, {
      currentDocument: null,
      isLoadingDetail: false,
      loadError: '无权访问该文档，请联系文档所有者申请权限',
    })

    flushSync(() => {
      root.render(<Harness documentId="doc-1" version="v1" />)
    })

    await actFlush()

    expect(collabProviderMock).toHaveBeenLastCalledWith(null)
  })

  it('文档详情成功加载后才创建协作连接配置', async () => {
    Object.assign(docEditorStub, {
      currentDocument: { id: 'doc-1' },
      isLoadingDetail: false,
      loadError: null,
    })

    flushSync(() => {
      root.render(<Harness documentId="doc-1" version="v1" />)
    })

    await actFlush()

    expect(collabProviderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentName: 'docs:doc-1',
        token: 'jwt-token',
      }),
    )
  })

  it('服务端请求刷新协作 token 时调用宿主刷新并更新 provider token', async () => {
    Object.assign(docEditorStub, {
      currentDocument: { id: 'doc-1' },
      isLoadingDetail: false,
      loadError: null,
    })

    flushSync(() => {
      root.render(<Harness documentId="doc-1" version="v1" />)
    })

    await actFlush()

    const initialOptions = collabProviderMock.mock.lastCall?.[0] as {
      onTokenRefreshRequired?: () => Promise<void>
    }
    expect(initialOptions).toEqual(expect.objectContaining({ token: 'jwt-token' }))

    await act(async () => {
      await initialOptions.onTokenRefreshRequired?.()
      await Promise.resolve()
    })

    expect(configStub.auth.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(collabProviderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentName: 'docs:doc-1',
        token: 'jwt-token-refreshed',
      }),
    )
  })

  it('自己的 legacy 自动保存事件先到时不撤销本地正文', async () => {
    Object.assign(docEditorStub, {
      currentDocument: { id: 'doc-1', latest_version: 4 },
      saveState: 'dirty',
      isLoadingDetail: false,
      loadError: null,
    })
    autoSaveControllerMock.isDirty.mockReturnValue(true)
    autoSaveControllerMock.isSaving.mockReturnValue(true)

    flushSync(() => {
      root.render(<Harness documentId="doc-1" version="v1" />)
    })
    await actFlush()

    expect(eventStreamHandlerRef.current).not.toBeNull()
    act(() => {
      eventStreamHandlerRef.current?.({
        event: 'doc.events.save',
        data: { latest_version: 5, updated_at: '2026-08-11T16:22:00Z' },
      })
    })

    expect(recoverFromExternalUpdateMock).not.toHaveBeenCalled()
    expect(docEditorStub.retryLoad).not.toHaveBeenCalled()
    expect(markAwaitingRemoteApplyMock).not.toHaveBeenCalled()
    expect(docEditorStub.patchCurrentDocument).toHaveBeenCalledWith({
      latest_version: 5,
      updated_at: '2026-08-11T16:22:00Z',
    })
  })
})

async function actFlush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
