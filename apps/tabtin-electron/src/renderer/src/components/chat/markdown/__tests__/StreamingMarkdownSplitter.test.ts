import { describe, expect, it } from 'vitest'
import { splitStreamingMarkdown } from '../StreamingMarkdownSplitter'

/** 现有实现要求 content.length ≥ 200 且 last `\n\n` 索引 ≥ 100 才会切出 stable。 */
const HEAD = 'H'.repeat(120)

describe('splitStreamingMarkdown', () => {
  it('keeps completed blocks in stable and only grows tail', () => {
    const a = splitStreamingMarkdown(`${HEAD}\n\nPara two is streaming ${'t'.repeat(60)}`)
    const b = splitStreamingMarkdown(
      `${HEAD}\n\nPara two is streaming ${'t'.repeat(60)} further`,
    )
    expect(b.stable.startsWith(a.stable) || b.stable === a.stable).toBe(true)
    expect(b.stable + b.tail).toBe(
      `${HEAD}\n\nPara two is streaming ${'t'.repeat(60)} further`,
    )
    expect(a.stable.length).toBeGreaterThan(0)
    expect(b.stable).toBe(a.stable)
  })

  it('moves unclosed fence entirely into tail', () => {
    const src = `${HEAD}\n\n\`\`\`ts\nconst x = 1\n${'z'.repeat(80)}`
    const { stable, tail } = splitStreamingMarkdown(src)
    expect(stable.includes('```')).toBe(false)
    expect(tail.includes('```ts')).toBe(true)
    expect(stable + tail).toBe(src)
  })
})
