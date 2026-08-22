import { describe, it, expect, vi } from 'vitest'
import {
  matchActivationRules,
  matchSingleRule,
  globToRegex,
  matchLanguage,
  matchKeywords,
  matchUrlPatterns,
  type PageContext,
} from '../activation-matcher'

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// ── globToRegex ────────────────────────────────────

describe('globToRegex', () => {
  it('*://*.example.com/* matches https://www.example.com/page', () => {
    const re = globToRegex('*://*.example.com/*')
    expect(re.test('https://www.example.com/page')).toBe(true)
  })

  it('*://*.example.com/* matches http://sub.example.com/path/to/page', () => {
    const re = globToRegex('*://*.example.com/*')
    expect(re.test('http://sub.example.com/path/to/page')).toBe(true)
  })

  it('*://*.example.com/* matches https://example.com/page (root domain)', () => {
    const re = globToRegex('*://*.example.com/*')
    expect(re.test('https://example.com/page')).toBe(true)
  })

  it('does not match unrelated domain', () => {
    const re = globToRegex('*://*.example.com/*')
    expect(re.test('https://evil.com/example.com')).toBe(false)
  })

  it('escapes special regex characters: . ? + ^', () => {
    const re = globToRegex('https://a.b.c?q=1')
    expect(re.test('https://a.b.c?q=1')).toBe(true)
    expect(re.test('https://axbxc?q=1')).toBe(false)
  })

  it('consecutive * are collapsed to prevent ReDoS', () => {
    const pattern = '*'.repeat(100) + '://*.example.com/*'
    const re = globToRegex(pattern)
    const start = performance.now()
    re.test('https://www.example.com/page')
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })

  it('pattern exceeding 500 chars is truncated', () => {
    const longPattern = 'https://' + 'a'.repeat(500) + '.com/*'
    const re = globToRegex(longPattern)
    expect(re).toBeInstanceOf(RegExp)
  })

  it('case insensitive matching', () => {
    const re = globToRegex('*://Example.COM/*')
    expect(re.test('https://example.com/page')).toBe(true)
  })
})

// ── matchUrlPatterns ────────────────────────────────

describe('matchUrlPatterns', () => {
  it('returns false for empty patterns', () => {
    expect(matchUrlPatterns([], 'https://example.com')).toBe(false)
  })

  it('returns false for empty url', () => {
    expect(matchUrlPatterns(['*://*.example.com/*'], '')).toBe(false)
  })

  it('matches when at least one pattern matches', () => {
    const patterns = ['*://*.google.com/*', '*://*.example.com/*']
    expect(matchUrlPatterns(patterns, 'https://www.example.com/page')).toBe(true)
  })

  it('truncates URLs exceeding 4096 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(5000)
    expect(matchUrlPatterns(['*://*.example.com/*'], longUrl)).toBe(true)
  })
})

// ── matchLanguage ────────────────────────────────────

describe('matchLanguage', () => {
  it('exact match: zh matches zh', () => {
    expect(matchLanguage(['zh'], 'zh')).toBe(true)
  })

  it('prefix match: zh matches zh-CN', () => {
    expect(matchLanguage(['zh'], 'zh-CN')).toBe(true)
  })

  it('prefix match: en matches en-US', () => {
    expect(matchLanguage(['en'], 'en-US')).toBe(true)
  })

  it('no match: en does not match zh-CN', () => {
    expect(matchLanguage(['en'], 'zh-CN')).toBe(false)
  })

  it('returns false for undefined pageLanguage', () => {
    expect(matchLanguage(['en'], undefined)).toBe(false)
  })

  it('returns false for empty languages', () => {
    expect(matchLanguage([], 'en')).toBe(false)
  })

  it('case insensitive', () => {
    expect(matchLanguage(['EN'], 'en-us')).toBe(true)
  })
})

// ── matchKeywords ────────────────────────────────────

describe('matchKeywords', () => {
  it('case insensitive keyword match', () => {
    expect(matchKeywords(['Product'], 'product hunt daily')).toBe(true)
  })

  it('returns false when no keywords match', () => {
    expect(matchKeywords(['react'], 'vue angular svelte')).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(matchKeywords(['test'], '')).toBe(false)
  })

  it('returns false for empty keywords', () => {
    expect(matchKeywords([], 'some text')).toBe(false)
  })
})

// ── matchSingleRule ──────────────────────────────────

describe('matchSingleRule', () => {
  const ctx: PageContext = {
    url: 'https://www.example.com/page',
    title: 'Example Page',
    language: 'en-US',
  }

  it('type=always returns true', () => {
    expect(matchSingleRule({ type: 'always' }, ctx)).toBe(true)
  })

  it('type=url_pattern delegates to pattern matching', () => {
    expect(
      matchSingleRule(
        { type: 'url_pattern', patterns: ['*://*.example.com/*'] },
        ctx,
      ),
    ).toBe(true)
  })

  it('type=page_language matches', () => {
    expect(
      matchSingleRule({ type: 'page_language', languages: ['en'] }, ctx),
    ).toBe(true)
  })

  it('type=title_url_match matches title + url keywords', () => {
    expect(
      matchSingleRule(
        { type: 'title_url_match', keywords: ['Example'] },
        ctx,
      ),
    ).toBe(true)
  })

  it('type=title_url_match does not match absent keywords', () => {
    expect(
      matchSingleRule(
        { type: 'title_url_match', keywords: ['React', 'Vue'] },
        ctx,
      ),
    ).toBe(false)
  })

  it('type=title_url_match matches keyword in url', () => {
    expect(
      matchSingleRule(
        { type: 'title_url_match', keywords: ['example.com'] },
        ctx,
      ),
    ).toBe(true)
  })

  it('type=page_content still works as deprecated alias (backward compat)', () => {
    expect(
      matchSingleRule(
        { type: 'page_content', keywords: ['Example'] },
        ctx,
      ),
    ).toBe(true)
  })

  it('unknown type returns false', () => {
    expect(matchSingleRule({ type: 'unknown' as any }, ctx)).toBe(false)
  })
})

// ── matchActivationRules ────────────────────────────

describe('matchActivationRules', () => {
  const ctx: PageContext = {
    url: 'https://www.example.com/page',
    title: 'Example',
    language: 'en',
  }

  it('empty rules list returns false', () => {
    expect(matchActivationRules([], ctx)).toBe(false)
  })

  it('null/undefined rules returns false', () => {
    expect(matchActivationRules(null as any, ctx)).toBe(false)
    expect(matchActivationRules(undefined as any, ctx)).toBe(false)
  })

  it('mode=any: one match is enough', () => {
    const rules = [
      { type: 'url_pattern' as const, patterns: ['*://no-match.com/*'] },
      { type: 'always' as const },
    ]
    expect(matchActivationRules(rules, ctx, 'any')).toBe(true)
  })

  it('mode=all: all must match', () => {
    const rules = [
      { type: 'url_pattern' as const, patterns: ['*://*.example.com/*'] },
      { type: 'always' as const },
    ]
    expect(matchActivationRules(rules, ctx, 'all')).toBe(true)
  })

  it('mode=all: fails if one does not match', () => {
    const rules = [
      { type: 'url_pattern' as const, patterns: ['*://no-match.com/*'] },
      { type: 'always' as const },
    ]
    expect(matchActivationRules(rules, ctx, 'all')).toBe(false)
  })

  it('defaults to mode=any', () => {
    const rules = [
      { type: 'url_pattern' as const, patterns: ['*://no-match.com/*'] },
      { type: 'always' as const },
    ]
    expect(matchActivationRules(rules, ctx)).toBe(true)
  })
})
