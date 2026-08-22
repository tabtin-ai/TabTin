const PICKER_RETURN_GRACE_MS = 1_000
const PICKER_MAX_ACTIVE_MS = 60_000

let activePickers = 0
let graceUntil = 0
let graceTimer: ReturnType<typeof setTimeout> | null = null

function enterReturnGraceWindow() {
  graceUntil = Date.now() + PICKER_RETURN_GRACE_MS
  if (graceTimer) clearTimeout(graceTimer)
  graceTimer = setTimeout(() => {
    if (Date.now() >= graceUntil) {
      graceUntil = 0
      graceTimer = null
    }
  }, PICKER_RETURN_GRACE_MS)
}

/**
 * 原生文件选择器会让 Electron renderer 进入 blur / visible 往返。
 * 返回瞬间如果全局恢复逻辑刷新组织或 Space，React 可能重挂当前面板，
 * 让 file input 的 change 事件丢失。这个 guard 给文件选择流程一个短暂静默窗口。
 */
export function beginNativeFilePickerInteraction(): () => void {
  activePickers += 1
  graceUntil = 0
  if (graceTimer) {
    clearTimeout(graceTimer)
    graceTimer = null
  }

  let finished = false
  let removeFocusListener: (() => void) | null = null
  let maxActiveTimer: ReturnType<typeof setTimeout> | null = null

  const finish = () => {
    if (finished) return
    finished = true
    if (maxActiveTimer) {
      clearTimeout(maxActiveTimer)
      maxActiveTimer = null
    }
    activePickers = Math.max(0, activePickers - 1)
    removeFocusListener?.()
    removeFocusListener = null
    enterReturnGraceWindow()
  }

  maxActiveTimer = setTimeout(() => finish(), PICKER_MAX_ACTIVE_MS)

  if (typeof window !== 'undefined') {
    const onFocus = () => finish()
    window.addEventListener('focus', onFocus, { once: true })
    removeFocusListener = () => window.removeEventListener('focus', onFocus)
  }

  return finish
}

export function isNativeFilePickerInteractionActive(): boolean {
  return activePickers > 0 || graceUntil > Date.now()
}

export function getNativeFilePickerQuietDelayMs(): number {
  if (activePickers > 0) return PICKER_RETURN_GRACE_MS
  return Math.max(0, graceUntil - Date.now())
}

export function __resetNativeFilePickerGuardForTests() {
  activePickers = 0
  graceUntil = 0
  if (graceTimer) {
    clearTimeout(graceTimer)
    graceTimer = null
  }
}
