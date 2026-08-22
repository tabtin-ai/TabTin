import { describe, expect, it } from 'vitest'
import {
  isNearBottom,
  isProgrammaticScroll,
  isWheelConsumedByNestedScroller,
  isUpwardMessageListBrowseKey,
  isUpwardMessageListTouchMove,
  isUpwardMessageListWheel,
  isUserScrollUp,
  NEAR_BOTTOM_THRESHOLD_PX,
} from '../messageListScrollPolicy'

describe('messageListScrollPolicy', () => {
  describe('isNearBottom / isProgrammaticScroll', () => {
    it('贴底与阈值内 → true；超过阈值 → false', () => {
      expect(isNearBottom({
        scrollTop: 400,
        scrollHeight: 1000,
        clientHeight: 600,
      })).toBe(true)
      expect(isNearBottom({
        scrollTop: 400 - NEAR_BOTTOM_THRESHOLD_PX,
        scrollHeight: 1000,
        clientHeight: 600,
      })).toBe(true)
      expect(isNearBottom({
        scrollTop: 400 - NEAR_BOTTOM_THRESHOLD_PX - 1,
        scrollHeight: 1000,
        clientHeight: 600,
      })).toBe(false)
    })

    it('内容不足一屏（maxScroll=0）视为在底部', () => {
      expect(isNearBottom({
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 600,
      })).toBe(true)
    })

    it('isProgrammaticScroll：observed ≈ commanded', () => {
      expect(isProgrammaticScroll({ observed: 1000, commanded: 1000 })).toBe(true)
      expect(isProgrammaticScroll({ observed: 1001, commanded: 1000 })).toBe(true)
      expect(isProgrammaticScroll({ observed: 1002, commanded: 1000 })).toBe(false)
      expect(isProgrammaticScroll({ observed: 1000, commanded: null })).toBe(false)
    })
  })

  describe('isUserScrollUp (同步取消触底吸附的判定)', () => {
    it('用户上滚（相对上次观测上移超过阈值）→ true', () => {
      expect(isUserScrollUp({ observed: 900, prev: 1000, commanded: null })).toBe(true)
    })

    it('下滚 / 不动 → false', () => {
      expect(isUserScrollUp({ observed: 1000, prev: 900, commanded: null })).toBe(false)
      expect(isUserScrollUp({ observed: 1000, prev: 1000, commanded: null })).toBe(false)
    })

    it('亚像素上移（≤2px）不算用户上滚', () => {
      expect(isUserScrollUp({ observed: 999, prev: 1000, commanded: null })).toBe(false)
    })

    it('程序化贴底（observed ≈ 上次命令值）不取消——免疫连续 re-pin 自我取消', () => {
      // 我们刚把 scrollTop 命令为 1000，本次 observed=1000（相对 prev 上移也不算用户上滚）。
      expect(isUserScrollUp({ observed: 1000, prev: 1200, commanded: 1000 })).toBe(false)
      // observed 与 commanded 差 >1px 才回到「按位移判用户」的分支。
      expect(isUserScrollUp({ observed: 900, prev: 1200, commanded: 1000 })).toBe(true)
    })
  })

  describe('用户输入直接解除吸附（不依赖 scrollTop 增量）', () => {
    it('内层滚动区能继续消费手势时，不把滚轮意图交给外层对话', () => {
      const root = document.createElement('div')
      const nested = document.createElement('div')
      const target = document.createElement('span')
      nested.style.overflowY = 'auto'
      nested.append(target)
      root.append(nested)
      Object.defineProperties(nested, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 300 },
        scrollTop: { value: 40, writable: true },
      })

      expect(isWheelConsumedByNestedScroller({ target, root, deltaY: -10 })).toBe(true)
      nested.scrollTop = 0
      expect(isWheelConsumedByNestedScroller({ target, root, deltaY: -10 })).toBe(false)
    })

    it('滚轮上滚（deltaY<0）→ true；下滚 → false', () => {
      expect(isUpwardMessageListWheel(-10)).toBe(true)
      expect(isUpwardMessageListWheel(10)).toBe(false)
      expect(isUpwardMessageListWheel(0)).toBe(false)
    })

    it('键盘上翻键 → true；其它键 → false', () => {
      expect(isUpwardMessageListBrowseKey('ArrowUp')).toBe(true)
      expect(isUpwardMessageListBrowseKey('PageUp')).toBe(true)
      expect(isUpwardMessageListBrowseKey('Home')).toBe(true)
      expect(isUpwardMessageListBrowseKey('ArrowDown')).toBe(false)
      expect(isUpwardMessageListBrowseKey('Enter')).toBe(false)
    })

    it('触摸下拉超过阈值 → true；未超阈值 / 上推 → false', () => {
      expect(isUpwardMessageListTouchMove(100, 110)).toBe(true)
      expect(isUpwardMessageListTouchMove(100, 102)).toBe(false)
      expect(isUpwardMessageListTouchMove(100, 90)).toBe(false)
    })
  })
})
