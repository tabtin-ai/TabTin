import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  extractUrlFromTruncatedMediaStdout,
  mediaImageUrlIdentity,
  normalizeMediaImageUrl,
  parseMediaImageGenerateResult,
} from '../parseMediaImageGenerateResult'

const URL = 'https://example.com/apple.png'
const fixtureDir = dirname(fileURLToPath(import.meta.url))
const truncatedStdout = readFileSync(
  join(fixtureDir, '../__fixtures__/truncated-media-image-stdout.txt'),
  'utf8',
)

describe('parseMediaImageGenerateResult', () => {
  it('从 Django task 形态抽 result_urls[0]', () => {
    expect(
      parseMediaImageGenerateResult({
        success: true,
        status: 'succeeded',
        result_urls: [URL],
      }),
    ).toBe(URL)
  })

  it('优先 stored_urls', () => {
    expect(
      parseMediaImageGenerateResult({
        stored_urls: ['https://cdn.example.com/stored.png'],
        result_urls: [URL],
      }),
    ).toBe('https://cdn.example.com/stored.png')
  })

  it('解开 shell stdout 字符串 + CLI ok/data 信封', () => {
    const inner = JSON.stringify({
      ok: true,
      data: {
        success: true,
        status: 'succeeded',
        result_urls: [URL],
      },
    })
    expect(
      parseMediaImageGenerateResult({
        stdout: inner,
        exit_code: 0,
      }),
    ).toBe(URL)
  })

  it('stdout 已是对象时仍能解析', () => {
    expect(
      parseMediaImageGenerateResult({
        stdout: JSON.stringify({ result_url: URL }),
        exit_code: 0,
      }),
    ).toBe(URL)
  })

  it('无 URL 返回 undefined', () => {
    expect(parseMediaImageGenerateResult({ stdout: 'ok', exit_code: 0 })).toBeUndefined()
    expect(parseMediaImageGenerateResult(null)).toBeUndefined()
  })

  it('live: 截断 stdout（pattern_matched 尾段）仍抽出 result_urls 并解 \\u0026', () => {
    const url = extractUrlFromTruncatedMediaStdout(truncatedStdout)
    expect(url).toMatch(/^https:\/\/ark-acg-cn-beijing\.tos-cn-beijing\.volces\.com\//)
    expect(url).toContain('X-Tos-Algorithm=')
    expect(url).toContain('&X-Tos-Signature=')
    expect(url).not.toContain('\\u0026')

    expect(
      parseMediaImageGenerateResult({
        status: 'completed',
        exit_code: 0,
        duration_ms: 44,
        stdout: truncatedStdout,
        pattern_matched: { text: '"status": "succeeded"' },
      }),
    ).toBe(url)
  })

  it('live: approval_note 前缀 + 信封字符串整包', () => {
    const envelope = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: truncatedStdout,
    })
    const wrapped = `<approval_note>\nUser approved tool 'run_terminal_command'.\n</approval_note>\n\n${envelope}`
    const url = parseMediaImageGenerateResult(wrapped)
    expect(url).toMatch(/^https:\/\/ark-acg-cn-beijing\.tos-cn-beijing\.volces\.com\//)
    expect(url).toContain('&X-Tos-')
  })
})

describe('normalizeMediaImageUrl / mediaImageUrlIdentity', () => {
  it('还原 present_to_user 残留的 \\u0026', () => {
    const broken =
      'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/path/img.jpeg?X-Tos-Algorithm=TOS4-HMAC-SHA256\\u0026X-Tos-SignedHeaders=host'
    const fixed = normalizeMediaImageUrl(broken)!
    expect(fixed).toContain('&X-Tos-SignedHeaders=host')
    expect(fixed).not.toContain('\\u0026')
    expect(mediaImageUrlIdentity(broken)).toBe(mediaImageUrlIdentity(fixed))
  })
})
