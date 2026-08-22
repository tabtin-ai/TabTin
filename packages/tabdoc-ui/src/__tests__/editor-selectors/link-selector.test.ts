import { describe, expect, it } from 'vitest'
import { isValidUrl, getUrlFromString } from '../../editor/selectors/link-selector'

/**
 * LinkSelector useEffect 焦点修复验证
 *
 * UI-1 (P0): useEffect 原先无依赖数组，每次重渲染都调用 focus()，抢占输入焦点。
 * 修复：添加空依赖数组 []，仅在组件挂载时 focus 一次。
 *
 * 由于 LinkSelector 依赖 novel 的 useEditor hook 和 Popover 等 UI 组件，
 * 完整的渲染测试需要大量 mock。此处通过静态分析验证 useEffect 依赖数组，
 * 并补充 URL 工具函数的单元测试确保修复未引入回归。
 */

describe('LinkSelector useEffect focus fix (UI-1)', () => {
  it('useEffect should have empty dependency array (static verification)', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const filePath = path.resolve(
      __dirname,
      '../../editor/selectors/link-selector.tsx'
    )
    const source = fs.readFileSync(filePath, 'utf-8')

    const useEffectPattern = /useEffect\(\s*\(\)\s*=>\s*\{[^}]*focus\(\)[^}]*\}\s*,\s*\[\s*\]\s*\)/s
    expect(source).toMatch(useEffectPattern)

    const noDepMatches = source.match(/useEffect\(\s*\(\)\s*=>\s*\{[^}]*?focus\(\)[^}]*?\}\s*\)/gs)
    if (noDepMatches) {
      for (const match of noDepMatches) {
        expect(match).not.toMatch(/\}\s*\)$/)
      }
    }
  })
})

describe('isValidUrl', () => {
  it('should return true for valid URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true)
    expect(isValidUrl('http://localhost:3000')).toBe(true)
    expect(isValidUrl('ftp://files.example.com')).toBe(true)
  })

  it('should return false for invalid URLs', () => {
    expect(isValidUrl('not a url')).toBe(false)
    expect(isValidUrl('')).toBe(false)
    expect(isValidUrl('example')).toBe(false)
  })
})

describe('getUrlFromString', () => {
  it('should return valid URLs as-is', () => {
    expect(getUrlFromString('https://example.com')).toBe('https://example.com')
  })

  it('should prepend https:// to domain-like strings', () => {
    expect(getUrlFromString('example.com')).toBe('https://example.com/')
    expect(getUrlFromString('docs.google.com')).toBe('https://docs.google.com/')
  })

  it('should return null/undefined for non-URL strings', () => {
    const result = getUrlFromString('not a url at all')
    expect(result).toBeFalsy()
  })

  it('should return null/undefined for strings with spaces and dots', () => {
    const result = getUrlFromString('hello world.txt')
    expect(result).toBeFalsy()
  })
})
