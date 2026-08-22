import { describe, expect, it } from 'vitest'
import { formatApiErrorMessage } from './base.js'

describe('formatApiErrorMessage', () => {
  it('prefixes backend code so conflict detectors can match', () => {
    expect(
      formatApiErrorMessage(
        {
          code: 'WORKING_DIR_CONFLICT',
          message: '该工作目录已绑定到当前设备上的另一个 Space',
        },
        'Failed to create space',
      ),
    ).toBe('WORKING_DIR_CONFLICT: 该工作目录已绑定到当前设备上的另一个 Space')
  })

  it('falls back to message, then code, then fallback', () => {
    expect(formatApiErrorMessage({ message: 'only message' }, 'fallback')).toBe('only message')
    expect(formatApiErrorMessage({ code: 'ONLY_CODE' }, 'fallback')).toBe('ONLY_CODE')
    expect(formatApiErrorMessage({}, 'fallback')).toBe('fallback')
    expect(formatApiErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
