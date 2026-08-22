/**
 * hydrateSessionCodeRoots / rehomeSessionCodeRoot 单测：
 * 批量回填本地镜像、重复调用幂等、缺失记录不写入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  hydrateSessionCodeRoots,
  rehomeSessionCodeRoot,
} from '../sessionCodeRootBinding'

describe('hydrateSessionCodeRoots', () => {
  beforeEach(() => {
    useSessionBoundCodeRootStore.getState().reset()
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agent: {
        listSessionCodeRoots: vi.fn(async ({ sessionIds }: { sessionIds: string[] }) => ({
          success: true,
          bindings: Object.fromEntries(
            sessionIds
              .filter((id) => id === 'sess-bound')
              .map((id) => [
                id,
                {
                  rootPath: '/repo/wt-feature',
                  revision: 3,
                  branch: 'feat/x',
                  boundAt: 1_700_000_000_000,
                },
              ]),
          ),
        })),
        rehomeSessionCodeRoot: vi.fn(async () => ({
          success: true,
          binding: {
            rootPath: '/repo/wt-feature',
            revision: 4,
            branch: 'feat/x',
            boundAt: 1_700_000_000_001,
          },
        })),
      },
    }
  })

  afterEach(() => {
    useSessionBoundCodeRootStore.getState().reset()
    delete (window as unknown as { tabtin?: unknown }).tabtin
  })

  it('批量回填命中绑定；缺失 session 不写镜像', async () => {
    const count = await hydrateSessionCodeRoots(['sess-bound', 'sess-empty', 'sess-bound'])
    expect(count).toBe(1)
    expect(useSessionBoundCodeRootStore.getState().getBinding('sess-bound')).toMatchObject({
      rootPath: '/repo/wt-feature',
      branch: 'feat/x',
      status: 'active',
    })
    expect(useSessionBoundCodeRootStore.getState().getBinding('sess-empty')).toBeNull()

    const listFn = (window as unknown as {
      tabtin: { agent: { listSessionCodeRoots: ReturnType<typeof vi.fn> } }
    }).tabtin.agent.listSessionCodeRoots
    expect(listFn).toHaveBeenCalledTimes(1)
    expect(listFn.mock.calls[0][0].sessionIds).toEqual(['sess-bound', 'sess-empty'])
  })

  it('IPC 不可用时返回 0 且不抛错', async () => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    await expect(hydrateSessionCodeRoots(['sess-bound'])).resolves.toBe(0)
    expect(useSessionBoundCodeRootStore.getState().getBinding('sess-bound')).toBeNull()
  })

  it('草稿转正 rehome：本地迁移并调 main IPC', async () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('local-pending-1', {
      rootPath: '/repo/wt-feature',
      branch: 'feat/x',
      status: 'active',
    })
    const moved = await rehomeSessionCodeRoot('local-pending-1', 'sess-real')
    expect(moved?.rootPath).toBe('/repo/wt-feature')
    expect(useSessionBoundCodeRootStore.getState().getBinding('local-pending-1')).toBeNull()
    expect(useSessionBoundCodeRootStore.getState().getBinding('sess-real')).toMatchObject({
      rootPath: '/repo/wt-feature',
      status: 'active',
    })
    const rehomeFn = (window as unknown as {
      tabtin: { agent: { rehomeSessionCodeRoot: ReturnType<typeof vi.fn> } }
    }).tabtin.agent.rehomeSessionCodeRoot
    expect(rehomeFn).toHaveBeenCalledWith({
      fromSessionId: 'local-pending-1',
      toSessionId: 'sess-real',
    })
  })
})
