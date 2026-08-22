import { describe, expect, it } from 'vitest'
import { shouldCaptureResponseBody } from '../attachRuntimeLogCapture'

describe('shouldCaptureResponseBody', () => {
  it('keeps capturing XHR/Fetch JSON', () => {
    expect(
      shouldCaptureResponseBody('XHR', 'application/json', 1200),
    ).toBe(true)
    expect(
      shouldCaptureResponseBody('Fetch', 'application/json; charset=utf-8', 800),
    ).toBe(true)
  })

  it('captures Script JSONP by URL hint (eastmoney search)', () => {
    const url =
      'https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery351_x&param=%7B%22type%22%3A%5B%22cmsArticleWebOld%22%5D%7D'
    expect(
      shouldCaptureResponseBody('Script', 'application/javascript', 4000, url),
    ).toBe(true)
    expect(
      shouldCaptureResponseBody('Script', undefined, 4000, url),
    ).toBe(true)
  })

  it('does not capture ordinary Script bundles', () => {
    expect(
      shouldCaptureResponseBody(
        'Script',
        'application/javascript',
        4000,
        'https://so.eastmoney.com/newstatic/js/page/search_main.js',
      ),
    ).toBe(false)
  })

  it('rejects oversized bodies', () => {
    expect(
      shouldCaptureResponseBody(
        'XHR',
        'application/json',
        512 * 1024 + 1,
      ),
    ).toBe(false)
  })
})
