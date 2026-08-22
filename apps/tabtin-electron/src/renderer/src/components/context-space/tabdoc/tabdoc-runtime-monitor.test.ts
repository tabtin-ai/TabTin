import { describe, expect, it } from 'vitest'
import {
  buildTabDocRuntimeMetrics,
  deriveTabDocRuntimeMonitorSnapshot,
} from './tabdoc-runtime-monitor'

describe('tabdoc-runtime-monitor', () => {
  it('优先把运行态归属到最近活跃的文档 pane', () => {
    const snapshot = deriveTabDocRuntimeMonitorSnapshot([
      {
        instanceId: 'host-active',
        meta: {
          documentId: 'doc-1',
          title: 'Active Doc',
          spaceId: 'space-1',
          organizationId: null,
          tabKey: 'tabdoc:doc-1',
          isPaneActive: true,
          isVisible: true,
          isLoading: false,
          hasError: false,
        },
        metrics: buildTabDocRuntimeMetrics({
          saveState: 'saved',
          saveMessage: 'ok',
          latestVersion: 9,
          revisionCount: 9,
          historyCount: 2,
          markdown: '# Hello\nworld',
          plaintext: 'Hello world',
          isCollaborating: true,
          activeEditorCount: 2,
          peerCount: 2,
          isAgentEditing: false,
          collabStatus: 'synced',
          eventStreamStatus: 'connected',
          isFallback: false,
          hasYdoc: true,
        }),
        registeredAt: 100,
        metaUpdatedAt: 200,
        metricsUpdatedAt: 300,
      },
      {
        instanceId: 'host-hidden',
        meta: {
          documentId: 'doc-2',
          title: 'Hidden Doc',
          spaceId: 'space-2',
          organizationId: null,
          tabKey: 'tabdoc:doc-2',
          isPaneActive: false,
          isVisible: false,
          isLoading: false,
          hasError: false,
        },
        metrics: buildTabDocRuntimeMetrics({
          saveState: 'dirty',
          saveMessage: 'pending',
          latestVersion: 4,
          revisionCount: 4,
          historyCount: 1,
          markdown: 'abc',
          plaintext: 'abc',
          isCollaborating: false,
          activeEditorCount: 0,
          peerCount: 0,
          isAgentEditing: false,
          collabStatus: 'initial',
          eventStreamStatus: 'idle',
          isFallback: true,
          hasYdoc: false,
        }),
        registeredAt: 120,
        metaUpdatedAt: 220,
        metricsUpdatedAt: 320,
      },
    ])

    expect(snapshot?.owner?.instanceId).toBe('host-active')
    expect(snapshot?.ownerStrategy).toBe('active-pane')
    expect(snapshot?.metrics?.saveState).toBe('saved')
    expect(snapshot?.metrics?.wordCount).toBe(2)
    expect(snapshot?.visibleHostCount).toBe(1)
  })

  it('所有 host 均 isLoading 时 ownerStrategy 应为 none', () => {
    const snapshot = deriveTabDocRuntimeMonitorSnapshot([
      {
        instanceId: 'host-loading',
        meta: {
          documentId: 'doc-1',
          title: null,
          spaceId: 'space-1',
          organizationId: null,
          tabKey: 'tabdoc:doc-1',
          isPaneActive: false,
          isVisible: false,
          isLoading: true,
          hasError: false,
        },
        metrics: null,
        registeredAt: 100,
        metaUpdatedAt: 200,
        metricsUpdatedAt: 0,
      },
    ])

    expect(snapshot?.ownerStrategy).toBe('none')
  })

  it('所有 host 均 hasError 时 ownerStrategy 应为 none', () => {
    const snapshot = deriveTabDocRuntimeMonitorSnapshot([
      {
        instanceId: 'host-error',
        meta: {
          documentId: 'doc-1',
          title: 'Error Doc',
          spaceId: 'space-1',
          organizationId: null,
          tabKey: 'tabdoc:doc-1',
          isPaneActive: false,
          isVisible: false,
          isLoading: false,
          hasError: true,
        },
        metrics: null,
        registeredAt: 100,
        metaUpdatedAt: 200,
        metricsUpdatedAt: 0,
      },
    ])

    expect(snapshot?.ownerStrategy).toBe('none')
  })
})
