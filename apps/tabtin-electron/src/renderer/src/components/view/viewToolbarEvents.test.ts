import { describe, expect, it } from 'vitest'

import {
  OPEN_VIEW_FILTER_POPOVER_EVENT,
  dispatchOpenViewFilterPopover,
} from './viewToolbarEvents'

describe('viewToolbarEvents', () => {
  it('派发打开筛选弹窗事件时带上 view 与字段锚点', () => {
    const events: CustomEvent[] = []
    const handleOpen = (event: Event) => {
      events.push(event as CustomEvent)
    }

    window.addEventListener(OPEN_VIEW_FILTER_POPOVER_EVENT, handleOpen)
    try {
      dispatchOpenViewFilterPopover({
        viewId: 'view-1',
        fieldId: 'field-status',
      })

      expect(events).toHaveLength(1)
      expect(events[0]?.detail).toEqual({
        viewId: 'view-1',
        fieldId: 'field-status',
      })
    } finally {
      window.removeEventListener(OPEN_VIEW_FILTER_POPOVER_EVENT, handleOpen)
    }
  })
})
