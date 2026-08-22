import { describe, expect, it } from 'vitest'
import {
  EMOJI_QUICK_PICKER_ESTIMATED_HEIGHT,
  EMOJI_QUICK_PICKER_VIEWPORT_MARGIN,
  EMOJI_QUICK_PICKER_WIDTH,
  resolveEmojiQuickPickerBounds,
  resolveEmojiQuickPickerPosition,
} from './emojiQuickPickerPosition'

describe('emojiQuickPickerPosition', () => {
  it('clamps left when end-aligned panel would overflow the viewport left edge', () => {
    const bounds = resolveEmojiQuickPickerBounds(null, 400, 800)
    const position = resolveEmojiQuickPickerPosition({
      anchorRect: { top: 200, bottom: 228, left: 40, right: 68 },
      bounds,
      align: 'end',
    })

    // 右对齐会算出 left=68-248=-180；应钳到视口左边距。
    expect(position.left).toBe(EMOJI_QUICK_PICKER_VIEWPORT_MARGIN)
    expect(position.placement).toBe('above')
  })

  it('clamps right when start-aligned panel would overflow the viewport right edge', () => {
    const bounds = resolveEmojiQuickPickerBounds(null, 400, 800)
    const position = resolveEmojiQuickPickerPosition({
      anchorRect: { top: 200, bottom: 228, left: 300, right: 328 },
      bounds,
      align: 'start',
    })

    expect(position.left).toBe(400 - EMOJI_QUICK_PICKER_VIEWPORT_MARGIN - EMOJI_QUICK_PICKER_WIDTH)
  })

  it('flips below when there is not enough room above inside the list viewport', () => {
    const bounds = {
      left: 8,
      right: 392,
      top: 80,
      bottom: 700,
    }
    const position = resolveEmojiQuickPickerPosition({
      anchorRect: { top: 100, bottom: 128, left: 120, right: 148 },
      bounds,
      align: 'start',
      panelHeight: EMOJI_QUICK_PICKER_ESTIMATED_HEIGHT,
    })

    expect(position.placement).toBe('below')
    expect(position.top).toBeGreaterThanOrEqual(bounds.top)
  })

  it('uses the message-list viewport bounds when provided', () => {
    const viewport = {
      getBoundingClientRect: () => ({
        left: 100,
        right: 500,
        top: 50,
        bottom: 650,
        width: 400,
        height: 600,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }),
    } as Element

    const bounds = resolveEmojiQuickPickerBounds(viewport, 1200, 800)
    expect(bounds.left).toBe(100 + EMOJI_QUICK_PICKER_VIEWPORT_MARGIN)
    expect(bounds.right).toBe(500 - EMOJI_QUICK_PICKER_VIEWPORT_MARGIN)
  })
})
