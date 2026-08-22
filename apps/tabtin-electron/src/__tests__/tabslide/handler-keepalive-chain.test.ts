import { describe, it, expect } from 'vitest'
import { slideHandler } from '../../renderer/src/components/context-space/registry/handlers/slide'

describe('slideHandler keepAlive 配置 (HOST-07)', () => {
  it('should have keepAlive enabled to avoid re-initialization on tab switch', () => {
    expect(slideHandler.keepAlive).toBe(true)
  })

  it('should have persistOnly enabled', () => {
    expect(slideHandler.persistOnly).toBe(true)
  })

  it('should have type set to tabslide', () => {
    expect(slideHandler.type).toBe('tabslide')
  })
})
