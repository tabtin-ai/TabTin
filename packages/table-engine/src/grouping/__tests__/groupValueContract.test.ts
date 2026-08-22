import { describe, expect, it } from 'vitest'
import {
  compareCanonicalGroupValues,
  resolveCanonicalGroupValue,
} from '../groupValueContract'

describe('groupValueContract', () => {
  it('treats multi-user and multi-select values as order-independent sets', () => {
    const users = {
      fieldType: 'user',
      userDisplayNameById: new Map([
        ['user-a', 'Alice'],
        ['user-b', 'Bob'],
      ]),
    }
    expect(resolveCanonicalGroupValue(['user-a', 'user-b'], users).key).toBe(
      resolveCanonicalGroupValue(['user-b', 'user-a'], users).key,
    )
    expect(resolveCanonicalGroupValue(['user-a', 'user-a'], users).key).toBe(
      resolveCanonicalGroupValue(['user-a'], users).key,
    )
    expect(resolveCanonicalGroupValue(['High', 'Low'], { fieldType: 'multi_select' }).key).toBe(
      resolveCanonicalGroupValue(['Low', 'High'], { fieldType: 'multi_select' }).key,
    )
    const choices = [{ value: 'Known' }]
    expect(compareCanonicalGroupValues(
      ['Unknown 10', 'Unknown 2', 'Unknown 2'],
      ['Unknown 2', 'Unknown 10'],
      { fieldType: 'multi_select', choices },
    )).toBe(0)
  })

  it('keeps UUID member identity stable while the member directory loads', () => {
    const memberId = '019ff9b8-9883-7c12-b953-7ca902fd4abd'
    const beforeDirectory = { fieldType: 'user', userDisplayNameById: new Map<string, string>() }
    const afterDirectory = {
      fieldType: 'user',
      userDisplayNameById: new Map([[memberId, 'Alice']]),
    }

    expect(resolveCanonicalGroupValue(memberId, beforeDirectory).key).toBe(
      `user:[${JSON.stringify(memberId)}]`,
    )
    expect(resolveCanonicalGroupValue({ id: memberId, name: 'Alice' }, beforeDirectory).key).toBe(
      resolveCanonicalGroupValue({ id: memberId, name: 'Alice' }, afterDirectory).key,
    )
  })

  it('uses configured choice order and deterministic natural text order', () => {
    const choices = [{ value: 'Todo' }, { value: 'Doing' }, { value: 'Done' }]
    expect(compareCanonicalGroupValues('Doing', 'Done', { fieldType: 'select', choices })).toBeLessThan(0)
    expect(compareCanonicalGroupValues('Task 2', 'Task 10')).toBeLessThan(0)
  })

  it('keeps the empty group last in both directions', () => {
    expect(compareCanonicalGroupValues(null, 'A', {}, 'asc')).toBeGreaterThan(0)
    expect(compareCanonicalGroupValues(null, 'A', {}, 'desc')).toBeGreaterThan(0)
  })

  it('uses numeric and timezone-stable date semantics', () => {
    expect(compareCanonicalGroupValues('2', '10', { fieldType: 'number' })).toBeLessThan(0)
    expect(
      compareCanonicalGroupValues(
        '2026-01-01T00:00:00',
        '2026-01-01T01:00:00Z',
        { fieldType: 'date' },
      ),
    ).toBeLessThan(0)
  })
})
