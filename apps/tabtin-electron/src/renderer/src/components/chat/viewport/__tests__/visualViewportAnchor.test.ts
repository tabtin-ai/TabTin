import { describe, expect, it } from 'vitest'
import {
  captureVisualViewportAnchor,
  measureVisualViewportAnchorShift,
} from '../visualViewportAnchor'

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 600,
    width: 600,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function makeViewportFixture() {
  const scroller = document.createElement('div')
  const content = document.createElement('div')
  const row = document.createElement('div')
  row.dataset.messageEnterKey = 'assistant-1'
  const block = document.createElement('div')
  block.dataset.viewportAnchor = 'content-block'
  row.append(block)
  content.append(row)
  scroller.append(content)
  scroller.getBoundingClientRect = () => rect(100, 700)
  return { scroller, content, row, block }
}

describe('visualViewportAnchor', () => {
  it('measures the real visual drift of the first stable visible content node', () => {
    const { scroller, content, row, block } = makeViewportFixture()
    row.getBoundingClientRect = () => rect(-200, 1_400)
    let blockTop = 80
    block.getBoundingClientRect = () => rect(blockTop, 260)

    const anchor = captureVisualViewportAnchor(scroller, content)
    expect(anchor?.element).toBe(block)
    expect(anchor?.offsetTop).toBe(-20)

    blockTop += 80
    expect(measureVisualViewportAnchorShift(scroller, anchor!)).toBe(80)
  })

  it('reports no drift when the same long row only grows below the anchored content', () => {
    const { scroller, content, row, block } = makeViewportFixture()
    let rowBottom = 1_400
    row.getBoundingClientRect = () => rect(-200, rowBottom)
    block.getBoundingClientRect = () => rect(80, 260)

    const anchor = captureVisualViewportAnchor(scroller, content)
    rowBottom += 600

    expect(measureVisualViewportAnchorShift(scroller, anchor!)).toBe(0)
  })

  it('falls back to the virtual row when React replaces the content node', () => {
    const { scroller, content, row, block } = makeViewportFixture()
    let rowTop = -200
    row.getBoundingClientRect = () => rect(rowTop, 1_400)
    block.getBoundingClientRect = () => rect(80, 260)

    const anchor = captureVisualViewportAnchor(scroller, content)
    block.remove()
    rowTop += 40

    expect(measureVisualViewportAnchorShift(scroller, anchor!)).toBe(40)
  })

  it('returns null when both the content node and its virtual row disappear', () => {
    const { scroller, content, row, block } = makeViewportFixture()
    row.getBoundingClientRect = () => rect(-200, 1_400)
    block.getBoundingClientRect = () => rect(80, 260)

    const anchor = captureVisualViewportAnchor(scroller, content)
    row.remove()

    expect(measureVisualViewportAnchorShift(scroller, anchor!)).toBeNull()
  })

  it('uses the virtual row when no finer stable content node exists', () => {
    const { scroller, content, row, block } = makeViewportFixture()
    delete block.dataset.viewportAnchor
    row.getBoundingClientRect = () => rect(80, 1_400)
    block.getBoundingClientRect = () => rect(120, 260)

    expect(captureVisualViewportAnchor(scroller, content)?.element).toBe(row)
  })
})
