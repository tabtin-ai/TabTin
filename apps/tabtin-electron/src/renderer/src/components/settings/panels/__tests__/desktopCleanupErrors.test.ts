import { describe, expect, it } from 'vitest'
import {
  normalizeWipeErrorCode,
  pickPrimaryWipeErrorCode,
  resolveCleanupCatchMessage,
  resolveCleanupFailureMessage,
} from '../desktopCleanupErrors'

const t = (key: string) => key

describe('desktopCleanupErrors', () => {
  it('normalizeWipeErrorCode 识别稳定码与 raw errno', () => {
    expect(normalizeWipeErrorCode('busy')).toBe('busy')
    expect(normalizeWipeErrorCode('EBUSY: resource busy or locked, unlink')).toBe('busy')
    expect(normalizeWipeErrorCode('EPERM: operation not permitted')).toBe('permission')
    expect(normalizeWipeErrorCode('something else')).toBe('unknown')
  })

  it('pickPrimaryWipeErrorCode 优先 busy', () => {
    expect(
      pickPrimaryWipeErrorCode([
        { errorCode: 'unknown' },
        { errorCode: 'permission' },
        { errorCode: 'busy' },
      ]),
    ).toBe('busy')
  })

  it('resolveCleanupFailureMessage 映射 i18n key 且不拼 raw', () => {
    const message = resolveCleanupFailureMessage(t, [
      { path: 'cache', errorCode: 'busy' },
    ])
    expect(message).toBe('desktopCleanup.errors.busy')
    expect(message).not.toMatch(/EBUSY/i)
  })

  it('resolveCleanupCatchMessage 吞掉 raw errno', () => {
    expect(resolveCleanupCatchMessage(t, new Error('EBUSY: locked'))).toBe(
      'desktopCleanup.errors.busy',
    )
    expect(resolveCleanupCatchMessage(t, new Error('LEGACY_SHAPE'))).toBe(
      'desktopCleanup.errors.unknown',
    )
  })
})
