import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markdownToPmJson } from '../markdownToPmJson.js'
import { pmJsonToMarkdown } from '../pmJsonToMarkdown.js'

interface Fixture {
  name: string
  description: string
  pmJson: Record<string, unknown>
  expectedMarkdown?: string
  invalidMarkdown?: string[]
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(currentDir, 'fixtures')

const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter(f => f.endsWith('.json'))
  .sort()
  .map(f => JSON.parse(readFileSync(join(fixturesDir, f), 'utf-8')))

describe('fixture round-trip: pmJson → md → pmJson → md', () => {
  for (const fixture of fixtures) {
    it(`round-trip: ${fixture.name}`, () => {
      const md1 = pmJsonToMarkdown(fixture.pmJson)
      const json2 = markdownToPmJson(md1)
      const md2 = pmJsonToMarkdown(json2 as Record<string, unknown>)
      expect(md2).toBe(md1)
    })
  }
})

describe('fixture expectedMarkdown verification', () => {
  const withExpected = fixtures.filter(f => f.expectedMarkdown != null)

  for (const fixture of withExpected) {
    it(`serialization: ${fixture.name}`, () => {
      const md = pmJsonToMarkdown(fixture.pmJson)
      expect(md).toBe(fixture.expectedMarkdown)
    })
  }
})

describe('fixture invalid Markdown verification', () => {
  for (const fixture of fixtures.filter(f => f.invalidMarkdown?.length)) {
    for (const markdown of fixture.invalidMarkdown ?? []) {
      it(`rejects invalid Markdown: ${fixture.name}: ${markdown.split('\n')[0]}`, () => {
        expect(() => markdownToPmJson(markdown)).toThrow(/tableId|tabdata/)
      })
    }
  }
})

describe('deep nesting round-trip (programmatic)', () => {
  function buildDeepBlockquote(depth: number, text: string): Record<string, unknown> {
    let node: Record<string, unknown> = {
      type: 'paragraph',
      content: [{ type: 'text', text }],
    }
    for (let i = 0; i < depth; i++) {
      node = { type: 'blockquote', content: [node] }
    }
    return { type: 'doc', content: [node] }
  }

  function buildDeepBulletList(depth: number): Record<string, unknown> {
    let current: Record<string, unknown> = {
      type: 'listItem',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: `Level ${depth}` }] },
      ],
    }
    current = { type: 'bulletList', content: [current] }

    for (let i = depth - 1; i >= 1; i--) {
      current = {
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: `Level ${i}` }] },
          current,
        ],
      }
      current = { type: 'bulletList', content: [current] }
    }
    return { type: 'doc', content: [current] }
  }

  it('round-trip: 5-level nested blockquote', () => {
    const doc = buildDeepBlockquote(5, 'Deep nested quote')
    const md1 = pmJsonToMarkdown(doc)
    expect(md1).toContain('>')
    const json2 = markdownToPmJson(md1)
    const md2 = pmJsonToMarkdown(json2 as Record<string, unknown>)
    expect(md2).toBe(md1)
  })

  it('round-trip: 10-level nested bullet list', () => {
    const doc = buildDeepBulletList(10)
    const md1 = pmJsonToMarkdown(doc)
    expect(md1).toContain('Level 1')
    expect(md1).toContain('Level 10')
    const json2 = markdownToPmJson(md1)
    const md2 = pmJsonToMarkdown(json2 as Record<string, unknown>)
    expect(md2).toBe(md1)
  })
})
