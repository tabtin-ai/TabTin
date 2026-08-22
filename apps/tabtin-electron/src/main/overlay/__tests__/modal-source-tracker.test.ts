import { describe, expect, it, vi } from 'vitest'

import { createModalSourceTracker } from '../modal-source-tracker'

function makeDriver() {
  return { show: vi.fn(), hide: vi.fn() }
}

describe('createModalSourceTracker', () => {
  it('keeps modal window visible until every overlay source is closed', () => {
    const driver = makeDriver()
    const tracker = createModalSourceTracker(driver)

    tracker.setOpen('update-prompt', true)
    tracker.setOpen('global-search', true)
    tracker.setOpen('global-search', false)

    expect(tracker.isOpen('update-prompt')).toBe(true)
    expect(driver.hide).not.toHaveBeenCalled()

    tracker.setOpen('update-prompt', false)

    expect(driver.hide).toHaveBeenCalledTimes(1)
  })

  it('阻塞型 source（confirm）→ 全屏（compact=false）', () => {
    const driver = makeDriver()
    const tracker = createModalSourceTracker(driver)

    tracker.setOpen('confirm', true)

    expect(driver.show).toHaveBeenLastCalledWith(false)
  })

  it('提示型 source（autofill-suggest）→ 贴角小窗（compact=true）', () => {
    const driver = makeDriver()
    const tracker = createModalSourceTracker(driver)

    tracker.setOpen('autofill-suggest', true)

    expect(driver.show).toHaveBeenLastCalledWith(true)
  })

  it('提示型 + 阻塞型混开 → 退化为全屏（compact=false）', () => {
    const driver = makeDriver()
    const tracker = createModalSourceTracker(driver)

    tracker.setOpen('autofill-suggest', true)
    expect(driver.show).toHaveBeenLastCalledWith(true)

    tracker.setOpen('confirm', true)
    expect(driver.show).toHaveBeenLastCalledWith(false)

    // 阻塞型关闭后只剩提示型 → 回到贴角小窗
    tracker.setOpen('confirm', false)
    expect(driver.show).toHaveBeenLastCalledWith(true)
  })

  it('does not re-raise modal when another source is already open', () => {
    const show = vi.fn()
    const hide = vi.fn()
    const tracker = createModalSourceTracker({ show, hide })

    tracker.setOpen('update-prompt', true)
    tracker.setOpen('update-prompt', true)
    tracker.setOpen('global-search', true)

    expect(show).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
  })
})
