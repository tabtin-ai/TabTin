import { describe, expect, it } from 'vitest'
import {
  localDateInputToCreatedAfterIso,
  localDateInputToCreatedBeforeIso,
} from '../walletTransactionTimeRange'

describe('walletTransactionTimeRange', () => {
  it('returns undefined for blank input', () => {
    expect(localDateInputToCreatedAfterIso('')).toBeUndefined()
    expect(localDateInputToCreatedAfterIso('  ')).toBeUndefined()
    expect(localDateInputToCreatedBeforeIso('')).toBeUndefined()
  })

  it('maps a calendar day to inclusive local start before local end-of-day', () => {
    const start = localDateInputToCreatedAfterIso('2030-06-01')
    const end = localDateInputToCreatedBeforeIso('2030-06-01')
    expect(start).toBeDefined()
    expect(end).toBeDefined()
    expect(new Date(start!).getTime()).toBeLessThan(new Date(end!).getTime())
  })
})
