import { describe, expect, it } from 'vitest'
import { getViewToolbarActions, isViewToolbarActionVisible } from '../viewToolbarActions'

describe('getViewToolbarActions', () => {
  it('returns kanban ordered actions', () => {
    expect(getViewToolbarActions('kanban')).toEqual([
      'group',
      'cardConfig',
      'filter',
      'sort',
    ])
  })

  it('returns calendar ordered actions', () => {
    expect(getViewToolbarActions('calendar')).toEqual(['calendarConfig', 'filter'])
  })

  it('returns gallery ordered actions', () => {
    expect(getViewToolbarActions('gallery')).toEqual(['cardConfig', 'filter', 'sort'])
  })

  it('keeps full grid toolbar for grid and unknown types', () => {
    const expected = [
      'hideFields',
      'filter',
      'sort',
      'group',
      'hierarchy',
      'preferences',
      'editView',
    ]
    expect(getViewToolbarActions('grid')).toEqual(expected)
    expect(getViewToolbarActions(undefined)).toEqual(expected)
    expect(getViewToolbarActions('custom')).toEqual(expected)
  })
})

describe('isViewToolbarActionVisible', () => {
  it('hides sort on calendar and group on gallery', () => {
    expect(isViewToolbarActionVisible('calendar', 'sort')).toBe(false)
    expect(isViewToolbarActionVisible('gallery', 'group')).toBe(false)
    expect(isViewToolbarActionVisible('kanban', 'cardConfig')).toBe(true)
  })
})
