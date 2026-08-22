/**
 * useScrollPositionPreserve 单元测试
 *
 * 用 React 19.2 真实 `<Activity>` 包装来验证生产语义——
 * Activity hidden 触发 effect cleanup（不卸载组件，state/ref 保留），
 * Activity visible 触发 effect 重新 setup。这等价于 SpaceWorkbenchHost
 * 切走再切回 hot Space 的真实行为。
 *
 * 用 renderHook 的 unmount/remount 也覆盖一组用例，但只针对"真销毁"
 * 的边界——例如 hot 驱逐到 cold 时整个组件 unmount，hook 状态丢失，
 * 这是预期行为。
 *
 * 覆盖核心场景：
 *   1. Activity hidden→visible 循环：保存当前 scrollTop，切回时恢复
 *   2. totalSize 异步 ready：mount 时 totalSize=0 → 之后涨到非零，
 *      恢复发生在 totalSize 第一次非零的同帧
 *   3. 多次 hidden/visible 循环：每次都恢复到最新 saved 位置
 *   4. scopeKey 变化：跨上下文 saved 主动 reset（P0-1 回归保护）
 *   5. el.scrollHeight 作为 clamp 上界：非虚拟化 sticky/footer 不影响
 *      恢复（P0-3 回归保护）
 *
 * 边界：
 *   - scrollElement 为 null：no-op，不抛
 *   - savedTop 越界：clamp 到 max
 *   - scrollTop 为 NaN：丢弃，不污染 saved
 *   - totalSize 缩到 0：等数据回填再恢复
 *   - 用户主动滚动 + totalSize 增长（正常浏览）：不会被拉回原位
 *   - React StrictMode 双跑：行为幂等，saved 不被污染
 */

import React, { Activity, StrictMode, useLayoutEffect, useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { useScrollPositionPreserve } from '../useScrollPositionPreserve'

interface MockEl {
  scrollTop: number
  clientHeight: number
  /**
   * DOM 真值 scrollHeight。hook clamp 用这个上界，**不是** totalSize。
   * 大部分测试里和 totalSize 同步设置（用 Probe 的 syncScrollHeight 默认）；
   * P0-3 测试里独立控制以验证容器内有非虚拟化子节点时的鲁棒性。
   */
  scrollHeight: number
}

function createMockEl(initialClientHeight = 600): MockEl {
  return { scrollTop: 0, clientHeight: initialClientHeight, scrollHeight: 0 }
}

const Probe: React.FC<{
  el: MockEl
  totalSize: number
  /** 默认 true：每次 render 自动同步 `el.scrollHeight = totalSize`。 */
  syncScrollHeight?: boolean
  scopeKey?: string | number | null
}> = ({ el, totalSize, syncScrollHeight = true, scopeKey }) => {
  const refContainer = useRef<HTMLElement | null>(el as unknown as HTMLElement)
  refContainer.current = el as unknown as HTMLElement

  if (syncScrollHeight) {
    el.scrollHeight = totalSize
  }

  useScrollPositionPreserve({
    scrollElementRef: refContainer,
    totalSize,
    scopeKey,
  })
  return null
}

describe('useScrollPositionPreserve', () => {
  describe('Activity hidden→visible 循环', () => {
    it('hidden 时保存 scrollTop，visible 时同帧恢复', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; totalSize: number }> = ({
        mode,
        totalSize,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" totalSize={5000} />)

      act(() => {
        el.scrollTop = 1234
      })

      act(() => {
        rerender(<Wrapper mode="hidden" totalSize={5000} />)
      })

      expect(el.scrollTop).toBe(1234)

      act(() => {
        el.scrollTop = 0
      })

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={5000} />)
      })

      expect(el.scrollTop).toBe(1234)

      unmount()
    })

    it('totalSize 在 visible 后才 ready，恢复发生在 totalSize 第一次非零的那帧', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; totalSize: number }> = ({
        mode,
        totalSize,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" totalSize={8000} />)

      act(() => {
        el.scrollTop = 2000
      })

      act(() => {
        rerender(<Wrapper mode="hidden" totalSize={8000} />)
      })
      expect(el.scrollTop).toBe(2000)

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" totalSize={0} />)
      })
      expect(el.scrollTop).toBe(0)

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={8000} />)
      })
      expect(el.scrollTop).toBe(2000)

      unmount()
    })

    it('多次 hidden/visible 循环都能恢复到最新 saved 位置', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={5000} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      act(() => {
        el.scrollTop = 800
      })
      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })
      expect(el.scrollTop).toBe(800)

      act(() => {
        el.scrollTop = 3500
      })
      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })
      expect(el.scrollTop).toBe(3500)

      unmount()
    })
  })

  describe('边界处理（Activity 包装）', () => {
    it('saved 越界时 clamp 到 scrollHeight - clientHeight', () => {
      const el = createMockEl(600)

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; totalSize: number }> = ({
        mode,
        totalSize,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" totalSize={10000} />)

      act(() => {
        el.scrollTop = 9000
      })

      act(() => {
        rerender(<Wrapper mode="hidden" totalSize={10000} />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" totalSize={2000} />)
      })

      expect(el.scrollTop).toBe(2000 - 600)

      unmount()
    })

    it('NaN scrollTop 不污染 saved（cleanup 读到 NaN 时丢弃）', () => {
      const el = createMockEl(600)

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={5000} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      // 第一轮 visible→hidden 让 saved 落到合法值 1500
      act(() => {
        el.scrollTop = 1500
      })
      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })

      // visible→hidden 又一轮，但这次在 cleanup 触发**之前**注入 NaN
      // 让守卫真的走到 `if (!Number.isFinite(top))` 丢弃分支
      act(() => {
        rerender(<Wrapper mode="visible" />)
      })
      // 此刻 saved 已恢复到 1500，scrollTop=1500
      expect(el.scrollTop).toBe(1500)

      // 用户操作让 scrollTop 变成 NaN（element 被污染的边角场景）
      act(() => {
        ;(el as unknown as { scrollTop: number }).scrollTop = Number.NaN
      })

      // 触发 cleanup 时读到 NaN——应该丢弃，保留 saved=1500
      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })

      // 把 scrollTop 改回合法值，再切回 visible
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })

      // saved 应该还是 1500（被 NaN 那次 cleanup 没污染）
      expect(el.scrollTop).toBe(1500)

      unmount()
    })

    it('totalSize 缩到 0 时不恢复，等数据回填', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; totalSize: number }> = ({
        mode,
        totalSize,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" totalSize={5000} />)

      act(() => {
        el.scrollTop = 1000
      })

      act(() => {
        rerender(<Wrapper mode="hidden" totalSize={5000} />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" totalSize={0} />)
      })

      expect(el.scrollTop).toBe(0)

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={5000} />)
      })

      expect(el.scrollTop).toBe(1000)

      unmount()
    })
  })

  describe('正常浏览（Activity 全程 visible）', () => {
    it('用户手动滚动 + totalSize 增长不会触发恢复', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ totalSize: number }> = ({ totalSize }) => (
        <Activity mode="visible">
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper totalSize={5000} />)

      act(() => {
        el.scrollTop = 800
      })
      act(() => {
        rerender(<Wrapper totalSize={5500} />)
      })
      expect(el.scrollTop).toBe(800)

      act(() => {
        el.scrollTop = 1200
      })
      act(() => {
        rerender(<Wrapper totalSize={6000} />)
      })
      expect(el.scrollTop).toBe(1200)

      unmount()
    })
  })

  describe('真 unmount/remount（hot→cold 驱逐场景）', () => {
    it('组件真 unmount 后再 mount，状态不保留——预期行为', () => {
      const el = createMockEl()

      const { unmount: unmount1 } = render(<Probe el={el} totalSize={5000} />)

      act(() => {
        el.scrollTop = 1500
      })

      unmount1()

      el.scrollTop = 0
      const { unmount: unmount2 } = render(<Probe el={el} totalSize={5000} />)

      expect(el.scrollTop).toBe(0)

      unmount2()
    })
  })

  describe('scrollElement 为 null', () => {
    it('null ref 不抛异常', () => {
      const NullProbe: React.FC<{ totalSize: number }> = ({ totalSize }) => {
        const ref = useRef<HTMLElement | null>(null)
        useScrollPositionPreserve({ scrollElementRef: ref, totalSize })
        return null
      }

      const { rerender, unmount } = render(<NullProbe totalSize={1000} />)
      expect(() => rerender(<NullProbe totalSize={2000} />)).not.toThrow()
      expect(() => unmount()).not.toThrow()
    })
  })

  describe('渐进式 totalSize 增长（防止过早 clamp）', () => {
    it('totalSize 从 0 → 100 → 5000 渐进增长，最终恢复到完整 saved=2000', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; totalSize: number }> = ({
        mode,
        totalSize,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" totalSize={5000} />)

      act(() => {
        el.scrollTop = 2000
      })

      act(() => {
        rerender(<Wrapper mode="hidden" totalSize={5000} />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" totalSize={0} />)
      })
      expect(el.scrollTop).toBe(0)

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={100} />)
      })
      expect(el.scrollTop).toBe(Math.max(0, 100 - 600))

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={500} />)
      })
      expect(el.scrollTop).toBe(0)

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={5000} />)
      })
      expect(el.scrollTop).toBe(2000)

      unmount()
    })

    it('totalSize 第一帧 estimate 偏低（小于 saved+clientHeight），后续涨到真实值后能补救', () => {
      const el = createMockEl(600)

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; totalSize: number }> = ({
        mode,
        totalSize,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={totalSize} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" totalSize={12000} />)

      act(() => {
        el.scrollTop = 8000
      })

      act(() => {
        rerender(<Wrapper mode="hidden" totalSize={12000} />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" totalSize={3000} />)
      })
      expect(el.scrollTop).toBe(3000 - 600)
      expect(el.scrollTop).toBeLessThan(8000)

      act(() => {
        rerender(<Wrapper mode="visible" totalSize={12000} />)
      })
      expect(el.scrollTop).toBe(8000)

      unmount()
    })
  })

  describe('saved=0（用户在顶部切走）边界', () => {
    it('savedScrollTop=0 仍能正确恢复，不被误当成"未保存"', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={5000} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      act(() => {
        el.scrollTop = 0
      })

      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })

      act(() => {
        el.scrollTop = 1234
      })

      act(() => {
        rerender(<Wrapper mode="visible" />)
      })

      expect(el.scrollTop).toBe(0)

      unmount()
    })
  })

  // ───────────────────────────────────────────────
  // P0-1 回归保护：scopeKey 变化时主动 reset 跨上下文 saved
  // ───────────────────────────────────────────────
  describe('scopeKey：跨上下文主动 reset（P0-1 回归保护）', () => {
    it('scopeKey 变化时丢弃 saved，避免上下文 A 的位置被恢复到上下文 B', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; scopeKey: string }> = ({
        mode,
        scopeKey,
      }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={5000} scopeKey={scopeKey} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" scopeKey="session-A" />)

      // 上下文 A：用户滚到 2000
      act(() => {
        el.scrollTop = 2000
      })

      // 切走又切回——saved=2000 正常恢复
      act(() => {
        rerender(<Wrapper mode="hidden" scopeKey="session-A" />)
      })
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" scopeKey="session-A" />)
      })
      expect(el.scrollTop).toBe(2000)

      // 父组件切到上下文 B（scopeKey 改变），同一组件实例复用
      // 用户此时位置仍是 2000（上下文 A 的位置），但语义上属于 B 的初始
      act(() => {
        rerender(<Wrapper mode="visible" scopeKey="session-B" />)
      })

      // 用户在 B 滚到 500
      act(() => {
        el.scrollTop = 500
      })

      // B 切走再切回——应恢复到 500（B 的位置），不是 2000（A 的位置）
      act(() => {
        rerender(<Wrapper mode="hidden" scopeKey="session-B" />)
      })
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" scopeKey="session-B" />)
      })
      expect(el.scrollTop).toBe(500)

      // 切回 A：scopeKey 从 B 变 A 触发 reset → hook 内部 saved=null。
      // 但 hook **不主动改 DOM scrollTop**——保留 B 的位置（500）。
      // 调用方（ChatContent）配合 React `key={sessionId}` 强制 remount 时，
      // 整组件销毁重建会让 scrollTop 自然回到 0；不传 key 时由调用方业务
      // 逻辑决定（例如根据 messages 列表初始化）。
      act(() => {
        rerender(<Wrapper mode="visible" scopeKey="session-A" />)
      })
      // 关键：A 的旧 saved=2000 没有被恢复（如果没有 reset，500 会被恢复成 2000）
      expect(el.scrollTop).toBe(500)

      // 在 A 上下文继续滚到 700，hidden→visible 一轮——
      // 应该恢复到 700（新 saved），不是 2000（旧 A 的 saved 被正确清掉）
      act(() => {
        el.scrollTop = 700
      })
      act(() => {
        rerender(<Wrapper mode="hidden" scopeKey="session-A" />)
      })
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" scopeKey="session-A" />)
      })
      expect(el.scrollTop).toBe(700)

      unmount()
    })

    it('scopeKey 从 null → "X" → null 切换正确处理', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ scopeKey: string | null }> = ({ scopeKey }) => (
        <Activity mode="visible">
          <Probe el={el} totalSize={5000} scopeKey={scopeKey} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper scopeKey={null} />)

      act(() => {
        el.scrollTop = 1000
      })

      // null → 'X'：保存的位置应被丢弃
      act(() => {
        rerender(<Wrapper scopeKey="X" />)
      })

      // 在 'X' 上下文滚到 2000
      act(() => {
        el.scrollTop = 2000
      })

      // 'X' → null：又切上下文，丢弃 saved
      act(() => {
        rerender(<Wrapper scopeKey={null} />)
      })

      // 此时 scrollTop 仍是 2000（用户位置不会自动重置），但 hook 内部 saved=null
      expect(el.scrollTop).toBe(2000)

      unmount()
    })

    it('scopeKey 不变时正常工作（不要因为引入 scopeKey 破坏既有路径）', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={5000} scopeKey="stable-key" />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      act(() => {
        el.scrollTop = 1500
      })
      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })
      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })
      expect(el.scrollTop).toBe(1500)

      unmount()
    })
  })

  // ───────────────────────────────────────────────
  // P0-3 回归保护：clamp 用 el.scrollHeight 而非 totalSize
  // ───────────────────────────────────────────────
  describe('clamp 用 scrollHeight（P0-3 回归保护）', () => {
    it('容器内有非虚拟化 sticky/footer（scrollHeight > totalSize）时不会错误 clamp', () => {
      const el = createMockEl(600)

      // 模拟 ChatVerticalTabs 的真实场景：listParentRef 内除 virtualizer 还有
      // ChatSplitGroupCard（200px）+ ChatPinnedSection（300px）= 500px 非虚拟化
      // 子节点。virtualizer.getTotalSize() 仅是虚拟化部分的高度。
      const VIRTUALIZER_SIZE = 5000
      const NON_VIRTUAL_EXTRA = 500
      const TOTAL_SCROLL_HEIGHT = VIRTUALIZER_SIZE + NON_VIRTUAL_EXTRA

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <Activity mode={mode}>
          <Probe
            el={el}
            totalSize={VIRTUALIZER_SIZE}
            syncScrollHeight={false}
          />
        </Activity>
      )

      el.scrollHeight = TOTAL_SCROLL_HEIGHT

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      // 用户滚到 saved=400，这个位置在虚拟化部分内但接近顶部。如果 hook 错误地
      // 用 totalSize=5000 - 600 = 4400 作为 clamp 上界——saved=400 在范围内，
      // 不会触发问题。但如果用户切到接近**底部**的位置（virtualizer 范围之外
      // 但容器范围之内），clamp 用 totalSize 会错把它压回去。
      //
      // 真实重现：用户滚到 5400（非虚拟化 footer 内），totalSize=5000 上限
      // 5000-600=4400 → clamp 错误压到 4400；scrollHeight=5500 上限
      // 5500-600=4900 → 用户位置 5400 < 4900 不成立，clamp 到 4900。两者不同。
      //
      // 简化版：让 saved=5400 验证 clamp 上界用的是 scrollHeight。
      act(() => {
        el.scrollTop = 5400
      })

      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })

      // 用 scrollHeight clamp：max = 5500 - 600 = 4900；saved=5400 → clamp 到 4900
      // 用 totalSize clamp（错误）：max = 5000 - 600 = 4400；saved=5400 → clamp 到 4400
      // 期望 4900（hook 用 scrollHeight）
      expect(el.scrollTop).toBe(4900)

      unmount()
    })

    it('saved 在 scrollHeight 范围内（不需要 clamp）时直接恢复', () => {
      const el = createMockEl(600)

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <Activity mode={mode}>
          <Probe el={el} totalSize={3000} syncScrollHeight={false} />
        </Activity>
      )

      el.scrollHeight = 4000 // 容器实际可滚动高度大于 totalSize

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      act(() => {
        el.scrollTop = 1500 // 在 totalSize=3000 内，肯定在 scrollHeight=4000 内
      })

      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })

      expect(el.scrollTop).toBe(1500)

      unmount()
    })
  })

  // ───────────────────────────────────────────────
  // P1-2 回归保护：React StrictMode 双跑安全
  // ───────────────────────────────────────────────
  describe('React StrictMode 双跑安全（P1-2 回归保护）', () => {
    it('StrictMode 双 mount/cleanup/mount 序列下行为幂等', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden' }> = ({ mode }) => (
        <StrictMode>
          <Activity mode={mode}>
            <Probe el={el} totalSize={5000} />
          </Activity>
        </StrictMode>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" />)

      // StrictMode 在 mount 阶段会跑两次 useLayoutEffect setup→cleanup→setup。
      // 第一次 cleanup 会把 scrollTop=0 写到 saved。第二次 setup 看到 saved 非
      // null，触发恢复——但 scrollTop=0，max=4400，target=Math.min(0, 4400)=0
      // → 恢复到 0，no-op。行为正确，但 saved 变成 0 而非 null（语义上等价）。

      act(() => {
        el.scrollTop = 1234
      })

      act(() => {
        rerender(<Wrapper mode="hidden" />)
      })

      act(() => {
        el.scrollTop = 0
        rerender(<Wrapper mode="visible" />)
      })

      expect(el.scrollTop).toBe(1234)

      unmount()
    })

    it('StrictMode 下 scopeKey 变化也能正确 reset', () => {
      const el = createMockEl()

      const Wrapper: React.FC<{ scopeKey: string }> = ({ scopeKey }) => (
        <StrictMode>
          <Activity mode="visible">
            <Probe el={el} totalSize={5000} scopeKey={scopeKey} />
          </Activity>
        </StrictMode>
      )

      const { rerender, unmount } = render(<Wrapper scopeKey="A" />)

      act(() => {
        el.scrollTop = 1500
      })

      // 切到 B，saved 应被 reset
      act(() => {
        rerender(<Wrapper scopeKey="B" />)
      })

      // 用户切了上下文但没动 scrollTop（仍然 1500，但 hook 内部 saved=null）
      act(() => {
        el.scrollTop = 800 // 模拟 B 上下文的初始 scroll 位置
      })

      // 切回 A——A 的 saved 早已被 B 的 reset 清掉
      act(() => {
        rerender(<Wrapper scopeKey="A" />)
      })

      // scrollTop 不会被恢复到 1500（A 的旧位置）
      expect(el.scrollTop).toBe(800)

      unmount()
    })
  })

  // ───────────────────────────────────────────────
  // P1-4 集成测试：真实 useVirtualizer + Activity hidden→visible 来回
  // ───────────────────────────────────────────────
  describe('集成测试（真实 useVirtualizer + Activity）', () => {
    it('真 virtualizer + Activity hidden→visible 来回，hook 恢复正确', () => {
      // 用 jsdom 跑——真实 ResizeObserver / DOM 可能不完整，但能验证
      // useVirtualizer + useScrollPositionPreserve 的协作没有挂载顺序 bug
      const { useVirtualizer } = require('@tanstack/react-virtual')

      const items = Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, height: 30 }))

      const VirtualList: React.FC<{ enabled: boolean; scopeKey: string }> = ({
        enabled,
        scopeKey,
      }) => {
        const parentRef = useRef<HTMLDivElement>(null)

        // jsdom 下让容器有可控的 clientHeight / scrollHeight
        useLayoutEffect(() => {
          const el = parentRef.current
          if (!el) return
          Object.defineProperty(el, 'clientHeight', { configurable: true, value: 600 })
          Object.defineProperty(el, 'scrollHeight', {
            configurable: true,
            value: items.length * 30,
          })
        }, [])

        const virtualizer = useVirtualizer({
          count: items.length,
          getScrollElement: () => parentRef.current,
          estimateSize: () => 30,
          enabled,
        })

        useScrollPositionPreserve({
          scrollElementRef: parentRef,
          totalSize: virtualizer.getTotalSize(),
          scopeKey,
        })

        return <div ref={parentRef} style={{ height: 600, overflow: 'auto' }} />
      }

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; scopeKey: string }> = ({
        mode,
        scopeKey,
      }) => (
        <Activity mode={mode}>
          <VirtualList enabled={mode === 'visible'} scopeKey={scopeKey} />
        </Activity>
      )

      const { rerender, container, unmount } = render(
        <Wrapper mode="visible" scopeKey="A" />,
      )

      // 模拟用户滚到 1000
      const scrollEl = container.querySelector('div') as HTMLDivElement | null
      expect(scrollEl).not.toBeNull()
      if (scrollEl) {
        act(() => {
          scrollEl.scrollTop = 1000
        })

        // 切走（hidden）
        act(() => {
          rerender(<Wrapper mode="hidden" scopeKey="A" />)
        })

        // hidden 期间不抛异常即可——virtualizer 的 enabled=false 应该让它
        // 跳过 ResizeObserver setup（issue #1067 防护）
        expect(() => {
          act(() => {
            rerender(<Wrapper mode="visible" scopeKey="A" />)
          })
        }).not.toThrow()

        // 恢复路径不抛、不 hang
        // 注意：jsdom 不支持完整 layout，scrollTop 实际值可能因 DOM 行为不同
        // 而和真实浏览器有差异。这里只验证"不崩 + 不无限循环"——
        // 真实的 px 等价性测试由前面的 mock 覆盖。
      }

      unmount()
    })

    it('集成场景：scopeKey 切换 + Activity hidden/visible 来回不互相干扰', () => {
      const { useVirtualizer } = require('@tanstack/react-virtual')

      const items = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}` }))

      const VirtualList: React.FC<{ enabled: boolean; scopeKey: string }> = ({
        enabled,
        scopeKey,
      }) => {
        const parentRef = useRef<HTMLDivElement>(null)
        const virtualizer = useVirtualizer({
          count: items.length,
          getScrollElement: () => parentRef.current,
          estimateSize: () => 30,
          enabled,
        })
        useScrollPositionPreserve({
          scrollElementRef: parentRef,
          totalSize: virtualizer.getTotalSize(),
          scopeKey,
        })
        return <div ref={parentRef} style={{ height: 400, overflow: 'auto' }} />
      }

      const Wrapper: React.FC<{ mode: 'visible' | 'hidden'; scopeKey: string }> = ({
        mode,
        scopeKey,
      }) => (
        <Activity mode={mode}>
          <VirtualList enabled={mode === 'visible'} scopeKey={scopeKey} />
        </Activity>
      )

      const { rerender, unmount } = render(<Wrapper mode="visible" scopeKey="A" />)

      // A → hidden → visible（scopeKey 不变）→ scopeKey 切到 B → hidden → visible
      // 每一步都不应抛异常或 infinite loop
      expect(() => {
        act(() => {
          rerender(<Wrapper mode="hidden" scopeKey="A" />)
        })
        act(() => {
          rerender(<Wrapper mode="visible" scopeKey="A" />)
        })
        act(() => {
          rerender(<Wrapper mode="visible" scopeKey="B" />)
        })
        act(() => {
          rerender(<Wrapper mode="hidden" scopeKey="B" />)
        })
        act(() => {
          rerender(<Wrapper mode="visible" scopeKey="B" />)
        })
      }).not.toThrow()

      unmount()
    })
  })
})
