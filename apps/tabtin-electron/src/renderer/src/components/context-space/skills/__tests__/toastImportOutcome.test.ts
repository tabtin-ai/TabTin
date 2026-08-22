import { describe, expect, it, vi } from 'vitest'
import {
  anyImportedAlreadyExists,
  resolveImportOutcomeKind,
  toastImportOutcome,
} from '../toastImportOutcome'

describe('resolveImportOutcomeKind', () => {
  it('maps already_exists to already_exists / else success', () => {
    expect(resolveImportOutcomeKind(true)).toBe('already_exists')
    expect(resolveImportOutcomeKind(false)).toBe('success')
  })
})

describe('anyImportedAlreadyExists', () => {
  it('is true when any item flags already_exists', () => {
    expect(anyImportedAlreadyExists([])).toBe(false)
    expect(anyImportedAlreadyExists([{ already_exists: false }])).toBe(false)
    expect(anyImportedAlreadyExists([
      { already_exists: false },
      { already_exists: true },
    ])).toBe(true)
    expect(anyImportedAlreadyExists([null, undefined, {}])).toBe(false)
  })
})

describe('toastImportOutcome', () => {
  it('shows info for reuse and success for new import', () => {
    const toastApi = { info: vi.fn(), success: vi.fn() }
    const t = (key: string) => key

    toastImportOutcome(toastApi, t, true)
    expect(toastApi.info).toHaveBeenCalledWith('skills.importAlreadyExists')
    expect(toastApi.success).not.toHaveBeenCalled()

    toastApi.info.mockClear()
    toastImportOutcome(toastApi, t, false)
    expect(toastApi.success).toHaveBeenCalledWith('skills.importSuccess')
    expect(toastApi.info).not.toHaveBeenCalled()
  })
})
