import { describe, it, expect } from 'vitest'
import { normalizeScrollIntent } from '../scroll-intent'

describe('normalizeScrollIntent', () => {
  it('缺省 / bottom / max → to_end', () => {
    expect(normalizeScrollIntent({})).toEqual({ kind: 'to_end' })
    expect(normalizeScrollIntent({ value: '' })).toEqual({ kind: 'to_end' })
    expect(normalizeScrollIntent({ value: 'bottom' })).toEqual({ kind: 'to_end' })
    expect(normalizeScrollIntent({ value: 'max' })).toEqual({ kind: 'to_end' })
  })

  it('value=top → to_start', () => {
    expect(normalizeScrollIntent({ value: 'top' })).toEqual({ kind: 'to_start' })
  })

  it('数字 value → by', () => {
    expect(normalizeScrollIntent({ value: '800' })).toEqual({ kind: 'by', deltaY: 800 })
    expect(normalizeScrollIntent({ value: -300 })).toEqual({ kind: 'by', deltaY: -300 })
  })

  it('direction+amount（Agent 常见写法）→ by', () => {
    expect(normalizeScrollIntent({ direction: 'down', amount: 800 })).toEqual({
      kind: 'by',
      deltaY: 800,
    })
    expect(normalizeScrollIntent({ direction: 'up', amount: 400 })).toEqual({
      kind: 'by',
      deltaY: -400,
    })
  })

  it('仅 direction=down → 默认 500px', () => {
    expect(normalizeScrollIntent({ direction: 'down' })).toEqual({ kind: 'by', deltaY: 500 })
  })

  it('direction=bottom 且无 amount → to_end', () => {
    expect(normalizeScrollIntent({ direction: 'bottom' })).toEqual({ kind: 'to_end' })
  })

  it('value 数字 + direction 决定符号', () => {
    expect(normalizeScrollIntent({ value: '200', direction: 'up' })).toEqual({
      kind: 'by',
      deltaY: -200,
    })
  })
})
