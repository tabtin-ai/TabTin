import { useCallback, useState } from 'react'

/**
 * 跨密码框共享的最近一次 Caps Lock 观测值。
 *
 * 裸 focus 无法查询修饰键；`KeyboardEvent` / `MouseEvent` / `PointerEvent`
 * 均支持 `getModifierState('CapsLock')`。敲键或点进密码框时写入 lastKnown，
 * 供 Tab 切入（无 pointer）时在 focus 上复用。
 */
let lastKnownCapsLockOn: boolean | null = null

/** 清空共享观测（弹窗关闭 / 表单卸载时调用）。 */
export function clearCapsLockWarningCache() {
  lastKnownCapsLockOn = null
}

/** 测试用别名，与 {@link clearCapsLockWarningCache} 相同。 */
export function __resetCapsLockWarningCacheForTests() {
  clearCapsLockWarningCache()
}

/** 方法形式：与 React Keyboard/Mouse/Pointer 的 getModifierState 签名兼容（属性函数形式会因参数逆变失败）。 */
type ModifierQueryEvent = {
  getModifierState?(key: string): boolean
}

/**
 * 密码框 Caps Lock 提示。
 *
 * 用法：`<input {...caps.inputHandlers} />` + `<CapsLockHint show={caps.capsLockOn} />`
 */
export function useCapsLockWarning() {
  const [capsLockOn, setCapsLockOn] = useState(false)

  const syncFromModifierEvent = useCallback((event: ModifierQueryEvent) => {
    if (typeof event.getModifierState !== 'function') return
    try {
      const on = event.getModifierState('CapsLock')
      lastKnownCapsLockOn = on
      setCapsLockOn(on)
    } catch {
      // 合成事件若不支持 getModifierState，静默忽略
    }
  }, [])

  const handleFocus = useCallback(() => {
    if (lastKnownCapsLockOn === null) return
    setCapsLockOn(lastKnownCapsLockOn)
  }, [])

  const handleBlur = useCallback(() => {
    setCapsLockOn(false)
  }, [])

  /** 清本框提示并丢掉共享观测（弹窗关闭等会话结束时用）。 */
  const resetCapsLockWarning = useCallback(() => {
    clearCapsLockWarningCache()
    setCapsLockOn(false)
  }, [])

  return {
    capsLockOn,
    inputHandlers: {
      onKeyDown: syncFromModifierEvent,
      onKeyUp: syncFromModifierEvent,
      // 打开前已开 Caps Lock：点进框即可提示，不必先敲字母
      onMouseDown: syncFromModifierEvent,
      onPointerDown: syncFromModifierEvent,
      onFocus: handleFocus,
      onBlur: handleBlur,
    },
    /** 供测试直接驱动；生产路径用 `inputHandlers`。 */
    handleKeyEvent: syncFromModifierEvent,
    handleFocus,
    handleBlur,
    resetCapsLockWarning,
  }
}
