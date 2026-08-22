/**
 * Wave 3.2 单元测试 — `useRunManager` cleanup 守卫语义。
 *
 * 北极星：高频切换 hot Space 时 Run 不被误杀。React 19.2 `<Activity mode="hidden">`
 * 触发 effect cleanup 但组件不卸载——hook 必须能区分「应该保活」和「真销毁」。
 *
 * 大部分用例直接验证 hook 的判断逻辑（shouldKeepRunOnCleanup 闭包）。case L 走
 * 真实 `<Activity>` 集成，验证 Wave 2c 落地后「endRun 分支同步清 state 与 ref」
 * 的一致性。
 */
import React, { Activity, useEffect } from 'react'
import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRunManager } from '@tabtin/crawlspace-core'

interface MockAdapter {
  create: ReturnType<typeof vi.fn>
  endRun: ReturnType<typeof vi.fn>
}

function createAdapter(): MockAdapter {
  return {
    create: vi.fn().mockResolvedValue({ success: true }),
    endRun: vi.fn().mockResolvedValue({ success: true }),
  }
}

describe('useRunManager — cleanup 守卫（Wave 3.2）', () => {
  let adapter: MockAdapter

  beforeEach(() => {
    adapter = createAdapter()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('A. Activity hidden（hot 仍在 + config 仍在）→ cleanup 不调 endRun', async () => {
    // 用户场景：用户从 Space A 切到 Space B，A 仍在 hot 集合且 config 未删。
    // Activity hidden 触发 cleanup，但 Run 不应被结束——切回 A 时应继续看到
    // 后台的爬虫工作。
    const shouldKeep = vi.fn().mockReturnValue(true)
    const { result, unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        userId: 'user-1',
        adapter,
        shouldKeepRunOnCleanup: shouldKeep,
      })
    )

    await act(async () => {
      await result.current.ensureRun()
    })
    expect(adapter.create).toHaveBeenCalledTimes(1)
    expect(result.current.runId).toBeTruthy()

    unmount()

    expect(shouldKeep).toHaveBeenCalledTimes(1)
    expect(adapter.endRun).not.toHaveBeenCalled()
  })

  it('B. hot 驱逐（spaceId 离开 hot 集合）→ cleanup 调 endRun', async () => {
    // 用户场景：hot 集合 LRU 满载，A 被挤出。SpaceWorkbenchHost 不再渲染 A，
    // hook 真 unmount。shouldKeepRunOnCleanup 返 false（spaceId 不在 hot）→ endRun。
    const shouldKeep = vi.fn().mockReturnValue(false)
    const { result, unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
        shouldKeepRunOnCleanup: shouldKeep,
      })
    )

    await act(async () => {
      await result.current.ensureRun()
    })

    unmount()

    expect(shouldKeep).toHaveBeenCalledTimes(1)
    expect(adapter.endRun).toHaveBeenCalledTimes(1)
    const [calledRunId, options] = adapter.endRun.mock.calls[0]
    expect(typeof calledRunId).toBe('string')
    expect(options).toEqual({ reason: 'unmount' })
  })

  it('C. 显式 closeCrawlspace（config 删除）→ cleanup 调 endRun（即便 spaceId 仍在 hot）', async () => {
    // 用户场景：Space A 还在 hot，但用户从 A 内点关闭 crawlspace。closeCrawlspace
    // 删 crawlspaceConfig → CrawlspaceWorkspace 不再渲染 → hook 真 unmount。
    // 双条件闭包：spaceId 在 hot=true，但 config=false → 整体 false → endRun。
    const shouldKeep = vi.fn().mockReturnValue(false)
    const { result, unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
        shouldKeepRunOnCleanup: shouldKeep,
      })
    )
    await act(async () => {
      await result.current.ensureRun()
    })

    unmount()

    expect(shouldKeep).toHaveBeenCalledTimes(1)
    expect(adapter.endRun).toHaveBeenCalledTimes(1)
  })

  it('D. 不传 shouldKeepRunOnCleanup → 保持原有"unmount 即 endRun"语义（向后兼容）', async () => {
    const { result, unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
      })
    )

    await act(async () => {
      await result.current.ensureRun()
    })

    unmount()

    expect(adapter.endRun).toHaveBeenCalledTimes(1)
    const [, options] = adapter.endRun.mock.calls[0]
    expect(options).toEqual({ reason: 'unmount' })
  })

  it('E. shouldKeepRunOnCleanup 闭包动态读：cleanup 时调用最新闭包，不会用 stale', async () => {
    // 用户场景：组件 mount 时 spaceId 在 hot；进入隐藏后用户切多次，关闭了 crawlspace；
    // 这时 hook 的 cleanup 触发，应该读最新的 hot+config 状态决定是否保活。
    let keep = true
    const { result, rerender, unmount } = renderHook(
      ({ keepFn }: { keepFn: () => boolean }) =>
        useRunManager({
          runPrefix: 'test',
          adapter,
          shouldKeepRunOnCleanup: keepFn,
        }),
      { initialProps: { keepFn: () => keep } }
    )

    await act(async () => {
      await result.current.ensureRun()
    })

    // 模拟「rerender 时换闭包」——hook 内部 ref 同步会拿到最新值
    rerender({ keepFn: () => keep })

    keep = false
    unmount()

    expect(adapter.endRun).toHaveBeenCalledTimes(1)
  })

  it('F. runIdRef 复用：保活路径不清 ref，下次 ensureRun 直接返回同一 runId（不重建）', async () => {
    // 用户场景：Activity hidden→visible，同一 hook 实例继续工作。我们无法在 renderHook
    // 直接模拟 hidden cleanup 后再 visible，这里用「先 ensureRun 拿 runId、再再次 ensureRun」
    // 验证幂等。真 Activity 切换的语义由 React 保证（state/ref 保留 + effect 走一遍 cleanup）。
    const { result } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
      })
    )

    let firstRunId: string | null = null
    await act(async () => {
      firstRunId = await result.current.ensureRun()
    })
    expect(firstRunId).toBeTruthy()

    let secondRunId: string | null = null
    await act(async () => {
      secondRunId = await result.current.ensureRun()
    })

    expect(secondRunId).toBe(firstRunId)
    expect(adapter.create).toHaveBeenCalledTimes(1)
  })

  it('G. runIdRef 未创建（ensureRun 没跑过）时 cleanup 直接 return，不调 endRun', () => {
    const shouldKeep = vi.fn().mockReturnValue(false)
    const { unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
        shouldKeepRunOnCleanup: shouldKeep,
      })
    )

    unmount()

    // 没 runId 走早退分支，shouldKeepRunOnCleanup 也不调
    expect(shouldKeep).not.toHaveBeenCalled()
    expect(adapter.endRun).not.toHaveBeenCalled()
  })

  it('H. 保活 + 真 unmount 复合：保活闭包返 true 后再变 false → 原 hook 实例 unmount 一次只释放一次', async () => {
    // 边界：先保活，再决策反转，单次 unmount 应该走 endRun 一次（即时读最新闭包）。
    let keep = true
    const { result, rerender, unmount } = renderHook(
      ({ keepFn }: { keepFn: () => boolean }) =>
        useRunManager({
          runPrefix: 'test',
          adapter,
          shouldKeepRunOnCleanup: keepFn,
        }),
      { initialProps: { keepFn: () => keep } }
    )

    await act(async () => {
      await result.current.ensureRun()
    })

    keep = false
    rerender({ keepFn: () => keep })

    unmount()

    expect(adapter.endRun).toHaveBeenCalledTimes(1)
  })

  it('I. adapter 引用变化（hot reload / host 重建）→ cleanup 走最新 adapter，不是 stale', async () => {
    // 用户场景：dev 模式 hot reload 触发 host 重建，adapter 引用变化。
    // 如果 cleanup 用了 stale adapter，endRun IPC 会发到旧的 adapter mock，
    // 实际生产里旧 adapter 持有的 IPC 通道可能已失效——Run 永远不会被结束。
    const newAdapter = createAdapter()
    const { result, rerender, unmount } = renderHook(
      ({ a }: { a: MockAdapter }) =>
        useRunManager({
          runPrefix: 'test',
          adapter: a,
        }),
      { initialProps: { a: adapter } }
    )

    await act(async () => {
      await result.current.ensureRun()
    })
    expect(adapter.create).toHaveBeenCalledTimes(1)

    // hot reload 换新 adapter
    rerender({ a: newAdapter })

    unmount()

    expect(newAdapter.endRun).toHaveBeenCalledTimes(1)
    expect(adapter.endRun).not.toHaveBeenCalled()
  })

  it('J. onRunCleanup 抛错 → cleanup 仍调 endRun（防御性两段 try/catch）', async () => {
    const onRunCleanup = vi.fn().mockImplementation(() => {
      throw new Error('user callback boom')
    })
    const { result, unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
        onRunCleanup,
      })
    )

    await act(async () => {
      await result.current.ensureRun()
    })

    unmount()

    expect(onRunCleanup).toHaveBeenCalledTimes(1)
    expect(adapter.endRun).toHaveBeenCalledTimes(1)
  })

  it('K. adapter.endRun reject → catch 兜住，不污染 unhandled rejection', async () => {
    // 用户场景：IPC 通道异常 / 主进程僵死，endRun 抛错。Wave 3.2 加了 .catch
    // 后 cleanup 不能因此变成 unhandled rejection 污染 error reporter。
    adapter.endRun.mockRejectedValue(new Error('ipc dead'))
    const { result, unmount } = renderHook(() =>
      useRunManager({
        runPrefix: 'test',
        adapter,
      })
    )

    await act(async () => {
      await result.current.ensureRun()
    })

    // 监听 unhandled rejection——不应触发
    const unhandledHandler = vi.fn()
    process.on('unhandledRejection', unhandledHandler)

    try {
      unmount()
      // 给 microtask 时间跑 .catch
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(adapter.endRun).toHaveBeenCalledTimes(1)
      expect(unhandledHandler).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandledHandler)
    }
  })

  it('L. Activity hidden 触发 endRun 分支：state 与 ref 同步清，visible 后 UI 不显示 stale runId（必修 2）', async () => {
    // 这是 Wave 2c 真实生效场景的集成测试：
    //
    // 1. 组件 visible → useRunManager mount → ensureRun → runId = R1
    // 2. 切到 hidden + shouldKeepRunOnCleanup 返 false（相当于 LRU 驱逐场景，
    //    或者 hot 集合手动清空）→ effect cleanup 跑，进 endRun 分支
    // 3. 之前的 bug：runIdRef = null 但 state.runId 仍是 R1
    // 4. 切回 visible → effect 重 setup（空体）→ Activity 保留 state →
    //    渲染期间 UI 看到的 runId 仍是 R1（stale，主进程已经 endRun 这个 id）
    // 5. 下游消费方（CrawlspaceShell 之类）拿到 stale R1 调 IPC → 主进程返
    //    "Run 不存在"
    //
    // 必修 2 后：cleanup 里 setRunId(null) 同步清 state，Activity hidden 期间
    // state 也是 null。visible 后 UI 立即看到 null（直到 ensureRun 重建）。
    const renderedIds: Array<string | null> = []
    const TestComponent: React.FC<{ mode: 'visible' | 'hidden'; ensureSignal: number }> = ({ mode, ensureSignal }) => {
      const { runId, ensureRun } = useRunManager({
        runPrefix: 'test',
        adapter,
        // 不传 shouldKeep → cleanup 默认走 endRun 分支
      })
      renderedIds.push(runId)
      useEffect(() => {
        if (ensureSignal > 0) {
          void ensureRun()
        }
      }, [ensureSignal, ensureRun])
      return <div data-testid="run-id">{runId ?? '<null>'}</div>
    }

    const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; ensureSignal: number }> = ({ mode, ensureSignal }) => (
      <Activity mode={mode}>
        <TestComponent mode={mode} ensureSignal={ensureSignal} />
      </Activity>
    )

    const { rerender, getByTestId } = render(<Wrapper mode="visible" ensureSignal={0} />)
    expect(getByTestId('run-id').textContent).toBe('<null>')

    // 触发 ensureRun
    await act(async () => {
      rerender(<Wrapper mode="visible" ensureSignal={1} />)
    })
    const runIdAfterEnsure = getByTestId('run-id').textContent
    expect(runIdAfterEnsure).toMatch(/^run-test-/)
    expect(adapter.create).toHaveBeenCalledTimes(1)

    // 切到 hidden → Activity 触发 effect cleanup → endRun 分支
    await act(async () => {
      rerender(<Wrapper mode="hidden" ensureSignal={1} />)
    })
    expect(adapter.endRun).toHaveBeenCalledTimes(1)

    // 切回 visible → effect 重 setup。state 必须已经被清成 null，否则会显示 stale runId
    await act(async () => {
      rerender(<Wrapper mode="visible" ensureSignal={1} />)
    })

    // 关键断言：从 hidden→visible 期间任意一帧的 runId 不应是「endRun 之前的旧值」
    // 因为 Activity 同实例若 cleanup 只清 ref 不清 state，state 会保留 stale 旧值
    // 直到下次 ensureRun setState 覆盖（中间渲染窗口暴露给消费方就出 bug）
    const idsAfterCleanup = renderedIds.slice(renderedIds.indexOf(runIdAfterEnsure) + 1)
    const hasStaleAfterEndRun = idsAfterCleanup.includes(runIdAfterEnsure)
    expect(hasStaleAfterEndRun).toBe(false)
  })
})
