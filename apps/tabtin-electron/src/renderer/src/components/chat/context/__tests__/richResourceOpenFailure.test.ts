import { describe, expect, it } from 'vitest'
import { shouldToastRichResourceOpenFailure } from '../richResourceOpenFailure'

describe('shouldToastRichResourceOpenFailure ', () => {
  it('toasts on error outcome', () => {
    expect(shouldToastRichResourceOpenFailure({
      outcome: 'error',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      errorMessage: 'boom',
      durationMs: 1,
    })).toBe(true)
  })

  it('toasts when self-format falls back to system_app_opened (silent click bug)', () => {
    expect(shouldToastRichResourceOpenFailure({
      outcome: 'system_app_opened',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      durationMs: 1,
    })).toBe(true)
  })

  it('does not toast on successful in_space_opened', () => {
    expect(shouldToastRichResourceOpenFailure({
      outcome: 'in_space_opened',
      carrierAppId: 'tabdoc',
      resolveSource: 'manifest_default',
      durationMs: 1,
    })).toBe(false)
  })

  it('does not toast when user intentionally ⌘/Ctrl+clicked for system app', () => {
    expect(shouldToastRichResourceOpenFailure({
      outcome: 'system_app_opened',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      durationMs: 1,
    }, { modifierExternal: true })).toBe(false)
  })
})
