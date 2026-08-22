/**
 * 全局键盘事件优先级调度器。
 *
 * 各组件通过 `keymapManager.register(priority, handler)` 注册，
 * Manager 在单一 `window.keydown` 上按优先级从高到低分发，
 * handler 返回 `true` 或调用 `e.preventDefault()` 后，后续低优先级 handler 不再触发。
 */

export enum KeyboardPriority {
  /** 临时覆盖层（ContextMenu、ZoomControls preset panel） */
  OVERLAY = 80,
  /** 全局快捷键（useKeyboard: delete/copy/paste/undo…） */
  GLOBAL = 40,
  /** 画布级（Canvas: 空格拖拽） */
  CANVAS = 20,
}

type KeyboardHandler = (e: KeyboardEvent) => boolean | void

interface Registration {
  priority: number
  handler: KeyboardHandler
}

class KeymapManager {
  private _registrations: Registration[] = []
  private _installed = false

  /**
   * 注册一个 keydown handler，返回取消注册的函数。
   * handler 返回 `true` 表示"已消费"，后续 handler 不再触发。
   */
  register(priority: number, handler: KeyboardHandler): () => void {
    const reg: Registration = { priority, handler }
    this._registrations.push(reg)
    this._registrations.sort((a, b) => b.priority - a.priority)
    this._ensureInstalled()
    return () => this._unregister(handler)
  }

  private _unregister(handler: KeyboardHandler): void {
    this._registrations = this._registrations.filter((r) => r.handler !== handler)
    if (this._registrations.length === 0) this._teardown()
  }

  private _dispatch = (e: KeyboardEvent): void => {
    const snapshot = this._registrations.slice()
    for (const reg of snapshot) {
      if (e.defaultPrevented) break
      const consumed = reg.handler(e)
      if (consumed === true) break
    }
  }

  private _ensureInstalled(): void {
    if (this._installed) return
    window.addEventListener('keydown', this._dispatch)
    this._installed = true
  }

  private _teardown(): void {
    window.removeEventListener('keydown', this._dispatch)
    this._installed = false
  }
}

export const keymapManager = new KeymapManager()
