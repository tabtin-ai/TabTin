/**
 * MessageList 用户输入判定策略纯函数。
 *
 * 贴底 / re-pin 由 ConversationViewportController 拥有；本模块只负责从 scroll /
 * wheel / 键盘 / 触摸事件里识别「用户上滚浏览」意图，供取消跟随吸附使用；
 * 以及「已接近底部」几何判定，供滑回底部后恢复跟随。
 */

/** 判定「本次 scroll 事件是我们自己程序化贴底」的容差（px）。 */
const PROGRAMMATIC_SCROLL_TOLERANCE_PX = 1
/** 判定「用户上滚」的最小位移（px），滤掉亚像素抖动。 */
const USER_SCROLL_UP_MIN_PX = 2
/**
 * 「接近底部」阈值（px）。用于滑回最新后隐藏「回到底部」并恢复 follow-latest；
 * 略宽于 1px 写入容差，覆盖触控板惯性与亚像素。
 */
export const NEAR_BOTTOM_THRESHOLD_PX = 16

/** 距合法最大 scrollTop 是否已在阈值内（含恰好贴底）。 */
export function isNearBottom(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  thresholdPx?: number
}): boolean {
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight)
  const threshold = input.thresholdPx ?? NEAR_BOTTOM_THRESHOLD_PX
  return maxScroll - input.scrollTop <= threshold
}

/** 是否为程序化 scroll（observed ≈ 上次 commanded）。 */
export function isProgrammaticScroll(input: {
  observed: number
  commanded: number | null
}): boolean {
  return input.commanded != null
    && Math.abs(input.observed - input.commanded) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX
}

/**
 * scroll 事件是否为「用户上滚」——据此同步取消触底吸附。
 *
 * 关键：区分用户滚动与我们自己的程序化贴底。程序化贴底会把 `commanded` 记为写入的
 * scrollTop；若本次 observed ≈ commanded 即视作程序化、不取消（免疫连续 re-pin 自我取消）。
 * 否则 observed 相对上次观测上移超过阈值即用户上滚。适用任何来源（滚轮 / 拖拽原生
 * 滚动条 / 键盘 / 触摸都产生 scroll 事件）。
 */
export function isUserScrollUp(input: {
  observed: number
  prev: number
  commanded: number | null
}): boolean {
  if (isProgrammaticScroll(input)) return false
  return input.observed < input.prev - USER_SCROLL_UP_MIN_PX
}

/** 触摸下拉（手指下移）判定为上滚浏览的最小位移（px）。 */
const TOUCH_BROWSE_UP_MIN_PX = 4

/**
 * 直接依据「真实用户输入」判定上滚浏览意图——不看 scrollTop 增量。
 *
 * 流式期间 pinToBottom 每帧把 scrollTop 拽回底部并同步刷新 prevObserved/commanded，
 * 导致 handleScroll 的 isUserScrollUp（靠 scrollTop 增量）常把用户上滚误判成程序化贴底、
 * 无法即时取消吸附。滚轮/键盘/触摸是**先于**同帧 layout→RO re-pin 派发的用户输入，据此
 * 直接解除吸附最稳。拖拽原生滚动条由 pointerdown 的 interactionActive 守卫覆盖，不在此列。
 */
export function isUpwardMessageListWheel(deltaY: number): boolean {
  return deltaY < 0
}

function isScrollableOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

/** Whether a nested vertical scroller can still consume this wheel gesture. */
export function isWheelConsumedByNestedScroller(input: {
  target: EventTarget | null
  root: HTMLElement
  deltaY: number
}): boolean {
  let element = input.target instanceof HTMLElement ? input.target : null
  while (element && element !== input.root) {
    const style = window.getComputedStyle(element)
    if (
      isScrollableOverflow(style.overflowY)
      && element.scrollHeight > element.clientHeight
    ) {
      if (input.deltaY < 0 && element.scrollTop > 0) return true
      if (
        input.deltaY > 0
        && element.scrollTop + element.clientHeight < element.scrollHeight
      ) return true
    }
    element = element.parentElement
  }
  return false
}

/** 键盘上翻键（向上浏览历史）。 */
export function isUpwardMessageListBrowseKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'PageUp' || key === 'Home'
}

/** 触摸下拉（手指相对起点下移超过阈值 = 内容上滚浏览）。 */
export function isUpwardMessageListTouchMove(startY: number, currentY: number): boolean {
  return currentY - startY > TOUCH_BROWSE_UP_MIN_PX
}
