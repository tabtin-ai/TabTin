import { describe, expect, it } from 'vitest'
import { calcGalleryColumns, resolveGalleryCardSize } from '../galleryCardLayout'

describe('galleryCardLayout', () => {
  it('resolveGalleryCardSize 校验合法值并回落 medium', () => {
    expect(resolveGalleryCardSize('small')).toBe('small')
    expect(resolveGalleryCardSize('medium')).toBe('medium')
    expect(resolveGalleryCardSize('large')).toBe('large')
    expect(resolveGalleryCardSize('huge')).toBe('medium')
    expect(resolveGalleryCardSize(undefined)).toBe('medium')
  })

  it('calcGalleryColumns 按 card_size 增减列数', () => {
    const width = 1100 // medium base = 4
    expect(calcGalleryColumns(width, 'medium')).toBe(4)
    expect(calcGalleryColumns(width, 'small')).toBe(5)
    expect(calcGalleryColumns(width, 'large')).toBe(3)
  })

  it('calcGalleryColumns 窄屏至少 1 列', () => {
    expect(calcGalleryColumns(320, 'large')).toBe(1)
    expect(calcGalleryColumns(320, 'small')).toBe(2)
  })
})
