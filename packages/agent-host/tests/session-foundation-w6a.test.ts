import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalPermissionHandler } from '@tabtin/agent-runtime'
import {
  assemblePermissionShell,
  createSessionStorageBundle,
} from '../src/runtime/index.js'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('W6a session foundation helpers', () => {
  it('createSessionStorageBundle keys archive by archiveThreadId and sessionConfig by sessionConfigThreadId', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'agent-host-w6a-'))
    tempRoots.push(dataRoot)

    const bundle = createSessionStorageBundle({
      organizationId: 'org-1',
      spaceId: 'space-1',
      archiveThreadId: 'business-thread',
      sessionConfigThreadId: 'runtime-thread',
      toolLogSessionId: 'session-1',
      dataRoot,
      userId: 'user-1',
      log: { warn: () => undefined },
    })

    expect(bundle.sessionConfig.threadId).toBe('runtime-thread')
    expect(bundle.sessionDir).toContain(join('users', 'user-1'))
    expect(bundle.sessionDir).toContain(join('organizations', 'org-1'))
    expect(bundle.sessionDir).toContain(join('workspaces', 'space-1'))
    expect(bundle.sessionDir).toContain(join('conversations', 'sessions'))
    expect(bundle.toolLogWriter).not.toBeNull()
    expect(bundle.sessionStorage).toBeTruthy()
    expect(bundle.snapshotStorage).toBeTruthy()
    expect(bundle.eventStorage).toBeTruthy()
    expect(bundle.toolResultStorage).toBeTruthy()
  })

  it('createSessionStorageBundle throws when organizationId/spaceId missing ', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'agent-host-w6a-'))
    tempRoots.push(dataRoot)

    expect(() =>
      createSessionStorageBundle({
        archiveThreadId: 'thread-1',
        sessionConfigThreadId: 'thread-1',
        toolLogSessionId: 'session-1',
        dataRoot,
        userId: 'user-1',
        // @ts-expect-error intentional hard-cut: missing org/space must fail
        organizationId: undefined,
        spaceId: undefined,
        log: { warn: () => undefined },
      }),
    ).toThrow(/organizationId\+spaceId/)
  })

  it('assemblePermissionShell requires workspaceId and wires handler + channel', () => {
    expect(() =>
      assemblePermissionShell({
        sessionId: 's1',
        workspaceId: '',
        apiBaseUrl: 'http://127.0.0.1:9',
        getAuthToken: () => null,
        emitStreamEvent: () => undefined,
        waitForUserInput: async () => ({}),
        runtimeMode: 'interactive',
        interactiveThreadId: 'thread-1',
        log: { warn: () => undefined, debug: () => undefined },
        createPermissionHandler: (options) => new LocalPermissionHandler(options),
      }),
    ).toThrow(/workspaceId is required/)

    const registerApprovalMemo = vi.fn()
    const onAlwaysCommitSuccess = vi.fn()
    const result = assemblePermissionShell({
      sessionId: 's1',
      workspaceId: 'ws-1',
      apiBaseUrl: 'http://127.0.0.1:9',
      getAuthToken: () => null,
      emitStreamEvent: () => undefined,
      waitForUserInput: async () => ({}),
      runtimeMode: 'interactive',
      interactiveThreadId: 'thread-1',
      log: { warn: () => undefined, debug: () => undefined },
      registerApprovalMemo,
      onAlwaysCommitSuccess,
      createPermissionHandler: (options) => new LocalPermissionHandler(options),
    })

    expect(registerApprovalMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        workspaceId: 'ws-1',
        store: result.permissionMemoStore,
      }),
    )
    expect(result.permissionHandler).toBeInstanceOf(LocalPermissionHandler)
    expect(typeof result.userInteractiveChannel.requestApprovalsBatch).toBe(
      'function',
    )
    // bootstrap is fire-and-forget; onAlwaysCommitSuccess is only for commit path
    expect(onAlwaysCommitSuccess).not.toHaveBeenCalled()
  })
})
