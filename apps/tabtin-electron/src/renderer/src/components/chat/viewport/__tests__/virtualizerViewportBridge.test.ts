import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationViewportEvent, ViewportMode } from '../types'
import { recordConversationViewportWrite } from '../conversationViewportProbe'
import {
  applyPrependCompensation,
  evaluateShouldAdjustForMeasuredSizeChange,
  navigateToVirtualItem,
  recoverEmptyVirtualWindow,
  restoreForegroundViewport,
  shouldAdjustForMeasuredSizeChange,
} from '../virtualizerViewportBridge'

vi.mock('../conversationViewportProbe', () => ({
  recordConversationViewportWrite: vi.fn(),
}))

const followMode: ViewportMode = { kind: 'follow-latest' }
const anchoredMode: ViewportMode = {
  kind: 'anchored-reading',
  reason: 'browse-history',
}

describe('virtualizerViewportBridge', () => {
  beforeEach(() => {
    vi.mocked(recordConversationViewportWrite).mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('evaluateShouldAdjustForMeasuredSizeChange', () => {
    it('leaves every measured-size correction to the viewport controller', () => {
      expect(evaluateShouldAdjustForMeasuredSizeChange({
        mode: followMode,
        itemStart: 20,
        itemEnd: 80,
        scrollOffset: 100,
        scrollAdjustments: 0,
      })).toBe(false)

      expect(evaluateShouldAdjustForMeasuredSizeChange({
        mode: anchoredMode,
        itemStart: 20,
        itemEnd: 80,
        scrollOffset: 100,
        scrollAdjustments: 0,
      })).toBe(false)

      expect(evaluateShouldAdjustForMeasuredSizeChange({
        mode: anchoredMode,
        itemStart: 120,
        itemEnd: 180,
        scrollOffset: 100,
        scrollAdjustments: 0,
      })).toBe(false)

      expect(evaluateShouldAdjustForMeasuredSizeChange({
        mode: anchoredMode,
        itemStart: 110,
        itemEnd: 115,
        scrollOffset: 100,
        scrollAdjustments: 24,
      })).toBe(false)

      expect(evaluateShouldAdjustForMeasuredSizeChange({
        mode: anchoredMode,
        itemStart: 100,
        itemEnd: 160,
        scrollOffset: 100,
      })).toBe(false)

      expect(recordConversationViewportWrite).not.toHaveBeenCalled()
    })

    it('does not compensate when the growing long row contains the reading point', () => {
      expect(evaluateShouldAdjustForMeasuredSizeChange({
        mode: anchoredMode,
        itemStart: 20,
        itemEnd: 900,
        scrollOffset: 400,
      })).toBe(false)
    })
  })

  describe('shouldAdjustForMeasuredSizeChange', () => {
    it('never records a virtualizer scroll write for measured-size changes', () => {
      expect(shouldAdjustForMeasuredSizeChange({
        mode: followMode,
        itemStart: 20,
        itemEnd: 80,
        scrollOffset: 100,
      })).toBe(false)
      expect(recordConversationViewportWrite).not.toHaveBeenCalled()

      expect(shouldAdjustForMeasuredSizeChange({
        mode: anchoredMode,
        itemStart: 20,
        itemEnd: 80,
        scrollOffset: 100,
      })).toBe(false)
      expect(recordConversationViewportWrite).not.toHaveBeenCalled()
    })
  })

  describe('applyPrependCompensation', () => {
    it('applies prepend compensation once without virtualizer probe writes', () => {
      const dispatch = vi.fn<(event: ConversationViewportEvent) => void>()
      applyPrependCompensation(dispatch, 860)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith({
        type: 'history-prepended',
        scrollTop: 860,
      })
      expect(recordConversationViewportWrite).not.toHaveBeenCalled()
    })
  })

  describe('navigateToVirtualItem', () => {
    it('navigate materializes the target and records one virtualizer write before scroll', () => {
      const calls: string[] = []
      const dispatch = vi.fn<(event: ConversationViewportEvent) => void>((event) => {
        calls.push(`dispatch:${event.type}`)
      })
      const scrollToIndex = vi.fn((
        _index: number,
        _options: { align: 'start' | 'center'; behavior: 'smooth' },
      ) => {
        calls.push('scrollToIndex')
      })
      vi.mocked(recordConversationViewportWrite).mockImplementation(() => {
        calls.push('record')
      })

      navigateToVirtualItem({
        messageKey: 'msg-7',
        index: 7,
        align: 'center',
        dispatch,
        scrollToIndex,
      })

      expect(dispatch).toHaveBeenCalledWith({
        type: 'navigate',
        messageKey: 'msg-7',
        align: 'center',
      })
      expect(scrollToIndex).toHaveBeenCalledWith(7, {
        align: 'center',
        behavior: 'smooth',
      })
      expect(recordConversationViewportWrite).toHaveBeenCalledTimes(1)
      expect(recordConversationViewportWrite).toHaveBeenCalledWith(
        'navigate',
        undefined,
        'virtualizer',
      )
      expect(calls).toEqual(['dispatch:navigate', 'record', 'scrollToIndex'])
    })
  })

  describe('restoreForegroundViewport', () => {
    it('foreground restore measures but does not follow or record virtualizer writes', () => {
      const calls: string[] = []
      const measure = vi.fn(() => {
        calls.push('measure')
      })
      const dispatch = vi.fn<(event: ConversationViewportEvent) => void>((event) => {
        calls.push(`dispatch:${event.type}`)
      })

      restoreForegroundViewport({ measure, dispatch })

      expect(measure).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith({
        type: 'layout-changed',
        reason: 'foreground-restored',
      })
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'follow-latest' }),
      )
      expect(recordConversationViewportWrite).not.toHaveBeenCalled()
      expect(calls).toEqual(['measure', 'dispatch:layout-changed'])
    })
  })

  describe('recoverEmptyVirtualWindow', () => {
    it('empty window recovery goes to the last item only while follow-latest', () => {
      const scrollToIndex = vi.fn()
      const calls: string[] = []
      vi.mocked(recordConversationViewportWrite).mockImplementation(() => {
        calls.push('record')
      })
      scrollToIndex.mockImplementation(() => {
        calls.push('scrollToIndex')
      })

      expect(recoverEmptyVirtualWindow({
        mode: followMode,
        itemCount: 5,
        virtualItemCount: 0,
        scrollToIndex,
      })).toBe(true)
      expect(scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' })
      expect(recordConversationViewportWrite).toHaveBeenCalledTimes(1)
      expect(recordConversationViewportWrite).toHaveBeenCalledWith(
        'empty-window',
        undefined,
        'virtualizer',
      )
      expect(calls).toEqual(['record', 'scrollToIndex'])

      scrollToIndex.mockClear()
      vi.mocked(recordConversationViewportWrite).mockClear()
      expect(recoverEmptyVirtualWindow({
        mode: anchoredMode,
        itemCount: 5,
        virtualItemCount: 0,
        scrollToIndex,
      })).toBe(false)
      expect(scrollToIndex).not.toHaveBeenCalled()
      expect(recordConversationViewportWrite).not.toHaveBeenCalled()

      expect(recoverEmptyVirtualWindow({
        mode: followMode,
        itemCount: 0,
        virtualItemCount: 0,
        scrollToIndex,
      })).toBe(false)

      expect(recoverEmptyVirtualWindow({
        mode: followMode,
        itemCount: 5,
        virtualItemCount: 3,
        scrollToIndex,
      })).toBe(false)
      expect(recordConversationViewportWrite).not.toHaveBeenCalled()
    })
  })
})
