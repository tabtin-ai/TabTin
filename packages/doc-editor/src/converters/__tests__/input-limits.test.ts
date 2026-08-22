import { describe, it, expect } from 'vitest'
import { markdownToPmJson } from '../markdownToPmJson.js'

describe('TS-INPUT-LIMIT: markdownToPmJson input size limits', () => {
  it('truncates input exceeding 5 MB', () => {
    const oneMB = 'x'.repeat(1024 * 1024)
    const sixMB = oneMB.repeat(6)
    expect(sixMB.length).toBeGreaterThan(5 * 1024 * 1024)

    const result = markdownToPmJson(sixMB) as { type: string; content: unknown[] }
    expect(result.type).toBe('doc')
    expect(result.content.length).toBeGreaterThan(0)

    const serialized = JSON.stringify(result)
    expect(serialized.length).toBeLessThan(sixMB.length)
  })

  it('truncates input exceeding 200K lines', () => {
    const lines = Array.from({ length: 250_000 }, (_, i) => `Line ${i}`)
    const markdown = lines.join('\n')

    const result = markdownToPmJson(markdown) as { type: string; content: unknown[] }
    expect(result.type).toBe('doc')
    expect(result.content.length).toBeLessThanOrEqual(200_000)
  })

  it('does not truncate small inputs', () => {
    const markdown = '# Hello\n\nWorld'
    const result = markdownToPmJson(markdown) as { type: string; content: unknown[] }
    expect(result.type).toBe('doc')
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(result.content[1]).toMatchObject({ type: 'paragraph' })
  })

  it('handles empty input gracefully', () => {
    const result = markdownToPmJson('') as { type: string; content: unknown[] }
    expect(result.type).toBe('doc')
    expect(result.content).toHaveLength(0)
  })
})
