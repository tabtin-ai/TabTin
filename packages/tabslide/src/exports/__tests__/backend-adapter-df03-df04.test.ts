/**
 * 回归测试 — DF-03 / DF-04
 *
 * DF-03: turningMode='no' 或未设置时，convertPagesToBackend 仍应输出 turningMode: ''
 *        以便后端增量保存清除 DB 旧值。
 * DF-04: animations 为空时，convertPagesToBackend 仍应输出 animations: []
 *        以便后端增量保存清除 DB 旧值。
 */
import { describe, it, expect } from 'vitest'
import { convertPagesToBackend } from '../backend-adapter'
import type { Slide, PPTAnimation } from '../../types/slides'

// ═══════════════════════════════════════════════
// DF-04: animations 空数组显式输出
// ═══════════════════════════════════════════════

describe('DF-04: animations 空数组应显式输出', () => {
  it('animations 未定义时应输出空数组', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage.animations).toBeDefined()
    expect(backendPage.animations).toEqual([])
  })

  it('animations 为空数组时应输出空数组', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      animations: [],
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage.animations).toBeDefined()
    expect(backendPage.animations).toEqual([])
  })

  it('animations 有值时正常序列化', () => {
    const anims: PPTAnimation[] = [
      {
        id: 'anim-1',
        elId: 'el_001',
        type: 'in' as const,
        effect: 'fadeIn',
        duration: 500,
        trigger: 'click' as const,
      },
    ]
    const page: Slide = {
      id: 'page-1',
      elements: [],
      animations: anims,
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage.animations).toHaveLength(1)
    expect(backendPage.animations![0]).toEqual({
      id: 'anim-1',
      elId: 'el_001',
      type: 'in',
      effect: 'fadeIn',
      duration: 500,
      trigger: 'click',
    })
  })
})

// ═══════════════════════════════════════════════
// DF-03: turningMode='no' 应输出空字符串
// ═══════════════════════════════════════════════

describe('DF-03: turningMode 清空应显式输出', () => {
  it('turningMode 未定义时应输出空字符串', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage).toHaveProperty('turningMode')
    expect(backendPage.turningMode).toBe('')
  })

  it('turningMode="no" 应输出空字符串', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      turningMode: 'no' as any,
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage).toHaveProperty('turningMode')
    expect(backendPage.turningMode).toBe('')
  })

  it('turningMode 有有效值时正常输出', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      turningMode: 'fade' as any,
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage.turningMode).toBe('fade')
  })
})
