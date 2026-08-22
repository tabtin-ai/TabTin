/**
 * Context Space 快捷键契约：主进程 before-input-event / 渲染进程 DOM keydown /
 * 渲染进程 IPC 三方共享的 action 字面量与辅助函数。
 *
 * ⚠️ 设计决策：⌘9 = 跳到最后一个 visible tab（而非第 9 个），和 Chrome / Arc / VSCode 对齐。
 */

/**
 * 数字键切换 tab 的 action 枚举。
 * - `switch-tab-1` ~ `switch-tab-8`：切到对应序号的 visible tab（1-based）
 * - `switch-tab-last`：切到最后一个 visible tab（⌘9 的语义）
 */
export type ContextSpaceShortcutSwitchTabAction =
  | 'switch-tab-1'
  | 'switch-tab-2'
  | 'switch-tab-3'
  | 'switch-tab-4'
  | 'switch-tab-5'
  | 'switch-tab-6'
  | 'switch-tab-7'
  | 'switch-tab-8'
  | 'switch-tab-last'

export type ContextSpaceShortcutAction =
  | 'refresh'
  | 'close'
  | 'new-tab'
  | 'reopen-closed-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'back'
  | 'forward'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'focus-url'
  | ContextSpaceShortcutSwitchTabAction

export type ContextSpaceNumericTabKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

/**
 * 数字键 ↔ action 映射。
 * 按键上生成的 `event.key` / `input.key` 为字符串 '1' ~ '9'，直接查表可得对应 action。
 * 键集合严格限定为 '1' ~ '9'，类型上即可防止误加 '0' 或其他字符。
 */
export const CONTEXT_SPACE_NUMERIC_TAB_ACTIONS: Readonly<Record<ContextSpaceNumericTabKey, ContextSpaceShortcutSwitchTabAction>> =
  Object.freeze({
    '1': 'switch-tab-1',
    '2': 'switch-tab-2',
    '3': 'switch-tab-3',
    '4': 'switch-tab-4',
    '5': 'switch-tab-5',
    '6': 'switch-tab-6',
    '7': 'switch-tab-7',
    '8': 'switch-tab-8',
    '9': 'switch-tab-last',
  })

const SWITCH_TAB_ACTIONS: ReadonlySet<ContextSpaceShortcutSwitchTabAction> = new Set<ContextSpaceShortcutSwitchTabAction>([
  'switch-tab-1',
  'switch-tab-2',
  'switch-tab-3',
  'switch-tab-4',
  'switch-tab-5',
  'switch-tab-6',
  'switch-tab-7',
  'switch-tab-8',
  'switch-tab-last',
])

const NUMERIC_TAB_KEYS: ReadonlySet<ContextSpaceNumericTabKey> = new Set<ContextSpaceNumericTabKey>([
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
])

/**
 * 根据按键字符（'0'~'9' / 'a' / 等）返回对应的 switch-tab action，
 * 没有匹配时返回 null。调用方（主进程 before-input-event 或渲染进程 keydown）
 * 都可以用 `if (action) ...` 直接分支。
 *
 * 特意不包含 '0'：⌘0 保留给 zoom-reset 的既有语义。
 */
export function getNumericTabAction(
  key: string,
): ContextSpaceShortcutSwitchTabAction | null {
  if (!NUMERIC_TAB_KEYS.has(key as ContextSpaceNumericTabKey)) return null
  return CONTEXT_SPACE_NUMERIC_TAB_ACTIONS[key as ContextSpaceNumericTabKey]
}

/**
 * 解析 switch-tab action 对应的 visible tab 索引。
 *
 * - `switch-tab-1` ~ `switch-tab-8`：返回 0~7；若越过 visibleCount 则返回 null（静默无响应）
 * - `switch-tab-last`：返回 visibleCount - 1；若 visible 列表为空则返回 null
 *
 * 对 visibleCount 做防御式检查（NaN / 负数 / 非整数）——即便调用方传来异常值也返回 null，
 * 不会让越界访问真的落到 visibleTabKeys 上。
 *
 * @param action 目标 switch-tab action
 * @param visibleCount 当前 visible tab 数量（不含 canvas group 内子 pane）
 * @returns 目标 visible tab 索引（0-based），或 null 表示静默无响应
 */
export function resolveSwitchTabIndex(
  action: ContextSpaceShortcutSwitchTabAction,
  visibleCount: number,
): number | null {
  if (!Number.isFinite(visibleCount) || visibleCount <= 0) return null
  const safeCount = Math.floor(visibleCount)
  if (action === 'switch-tab-last') {
    return safeCount - 1
  }
  const ordinal = Number.parseInt(action.slice('switch-tab-'.length), 10)
  if (!Number.isFinite(ordinal) || ordinal < 1 || ordinal > 8) return null
  const index = ordinal - 1
  if (index >= safeCount) return null
  return index
}

/**
 * 严格判断 action 是否属于 switch-tab 家族——基于白名单集合而非字符串前缀，
 * 避免将 `switch-tab-foo` 之类非法字面量误收窄为合法 action。
 */
export function isContextSpaceSwitchTabAction(
  action: ContextSpaceShortcutAction,
): action is ContextSpaceShortcutSwitchTabAction {
  return SWITCH_TAB_ACTIONS.has(action as ContextSpaceShortcutSwitchTabAction)
}
