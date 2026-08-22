/**
 * 流式内容选区保护。
 *
 * 在用户有文本选中时延迟 UI 通知，防止流式更新打断选区。
 * 当选区消失（selectionchange 有→无）或超过 3s 安全网后自动 flush。
 */

export interface SelectionGuard {
  /** 当前是否有活跃选区 */
  readonly hasActiveSelection: boolean
  /** 检查是否需要延迟通知。如果需要，缓存更新信息并返回 true */
  defer(sessionId: string): boolean
  /** 检查指定 session 是否在延迟中 */
  isDeferred(sessionId: string): boolean
  /** 立即刷新延迟的通知 */
  flush(): void
  /** 清理指定 session 的延迟状态（用于 clear） */
  clearSession(sessionId: string): void
  /** 清理全部状态（清除 timeout、重置所有延迟） */
  cleanup(): void
}

export function createSelectionGuard(
  onFlush: (sessionId: string) => void,
): SelectionGuard {
  let _hasActiveSelection = false
  let _deferredSessionId: string | null = null
  let _deferTimeout: ReturnType<typeof setTimeout> | null = null

  function _clearTimeout() {
    if (_deferTimeout) {
      clearTimeout(_deferTimeout)
      _deferTimeout = null
    }
  }

  function flush() {
    _clearTimeout()
    if (_deferredSessionId) {
      const sid = _deferredSessionId
      _deferredSessionId = null
      onFlush(sid)
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection()
      const hadSelection = _hasActiveSelection
      _hasActiveSelection = !!(sel && sel.toString().length > 0)

      if (hadSelection && !_hasActiveSelection) {
        flush()
      }
    })
  }

  return {
    get hasActiveSelection() {
      return _hasActiveSelection
    },

    defer(sessionId: string): boolean {
      if (!_hasActiveSelection) return false

      _deferredSessionId = sessionId
      if (!_deferTimeout) {
        _deferTimeout = setTimeout(() => {
          _deferTimeout = null
          if (_deferredSessionId) {
            const sid = _deferredSessionId
            _deferredSessionId = null
            _hasActiveSelection = false
            onFlush(sid)
          }
        }, 3000)
      }
      return true
    },

    isDeferred(sessionId: string): boolean {
      return _deferredSessionId === sessionId
    },

    flush,

    clearSession(sessionId: string) {
      if (_deferredSessionId === sessionId) {
        _deferredSessionId = null
        _clearTimeout()
      }
    },

    cleanup() {
      _deferredSessionId = null
      _clearTimeout()
    },
  }
}
