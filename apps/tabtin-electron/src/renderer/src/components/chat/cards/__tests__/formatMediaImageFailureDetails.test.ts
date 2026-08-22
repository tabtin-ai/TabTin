import { describe, expect, it } from 'vitest'
import { formatMediaImageFailureDetails } from '../formatMediaImageFailureDetails'

describe('formatMediaImageFailureDetails', () => {
  it('从 stderr / error 抽出可读文案', () => {
    expect(
      formatMediaImageFailureDetails({
        exit_code: 1,
        stderr: 'Seedream timed out',
        stdout: '',
      }),
    ).toContain('Seedream timed out')
  })

  it('字符串 output 直接展示', () => {
    expect(formatMediaImageFailureDetails('quota exceeded')).toBe('quota exceeded')
  })

  it('空 output 仍返回兜底说明（含 command）', () => {
    const text = formatMediaImageFailureDetails(undefined, 'tabtin media image generate --prompt x')
    expect(text).toContain('tabtin media image generate')
    expect(text).toContain('未能解析图片 URL')
  })

  it('空对象 {} 仍返回兜底，不空白', () => {
    const text = formatMediaImageFailureDetails({})
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).toContain('未能解析图片 URL')
  })
})
