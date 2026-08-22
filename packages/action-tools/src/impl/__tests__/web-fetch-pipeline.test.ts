import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { setHttpCrawlAPI } from '../../utils/runtime-bridge';
import { setCrawlToolRunnerFactory } from '../crawl-runner';
import { executeFetchPipeline } from '../web-fetch-pipeline';

const GOOD_HTML = `<!DOCTYPE html>
<html>
  <head><title>Example Article</title></head>
  <body>
    <article>
      <p>This is a long enough article body that should pass the content quality checks without needing browser fallback or special handling.</p>
    </article>
  </body>
</html>`;

const CAPTCHA_HTML = `<!DOCTYPE html>
<html>
  <head><title>Just a moment...</title></head>
  <body><div class="cf-turnstile"></div><p>Checking your browser</p></body>
</html>`;

describe('executeFetchPipeline', () => {
  afterEach(() => {
    setHttpCrawlAPI(null);
    setCrawlToolRunnerFactory(null);
    vi.restoreAllMocks();
  });

  it('returns success:true for readable HTML content', async () => {
    setHttpCrawlAPI({
      fetch: vi.fn().mockResolvedValue({
        success: true,
        data: {
          content: GOOD_HTML,
          content_type: 'text/html',
          status_code: 200,
          url: 'https://example.com/article',
          title: 'Example Article',
        },
      }),
    });

    const result = await executeFetchPipeline({
      url: 'https://example.com/article',
      autoFallback: false,
    });

    expect(result.success).toBe(true);
    expect(result.content.length).toBeGreaterThan(50);
    expect(result.quality.ok).toBe(true);
    // 未截断：不设 contentLength / fullContentPath
    expect(result.truncated).toBe(false);
    expect(result.contentLength).toBeUndefined();
    expect(result.fullContentPath).toBeUndefined();
  });

  it('returns success:false when captcha/challenge page is detected', async () => {
    setHttpCrawlAPI({
      fetch: vi.fn().mockResolvedValue({
        success: true,
        data: {
          content: CAPTCHA_HTML,
          content_type: 'text/html',
          status_code: 200,
          url: 'https://protected.example.com',
          title: 'Just a moment...',
        },
      }),
    });

    const result = await executeFetchPipeline({
      url: 'https://protected.example.com',
      autoFallback: false,
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe('');
    expect(result.quality.ok).toBe(false);
    expect(result.quality.reason).toBe('captcha');
    expect(result.error).toContain('captcha');
    expect(result.error).toContain('tabtin browser open');
  });

  it('returns success:true when browser fallback recovers quality', async () => {
    setHttpCrawlAPI({
      fetch: vi.fn().mockResolvedValue({
        success: true,
        data: {
          content: CAPTCHA_HTML,
          content_type: 'text/html',
          status_code: 200,
          url: 'https://protected.example.com',
          title: 'Just a moment...',
        },
      }),
    });

    setCrawlToolRunnerFactory(() => ({
      crawlCleanHtml: vi.fn().mockResolvedValue({
        success: true,
        clean_html: GOOD_HTML,
        title: 'Example Article',
        url: 'https://protected.example.com',
      }),
    }));

    const result = await executeFetchPipeline({
      url: 'https://protected.example.com',
      autoFallback: true,
      timeout: 30_000,
    });

    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe('browser');
    expect(result.quality.ok).toBe(true);
    expect(result.content.length).toBeGreaterThan(50);
  });

  it('persists full content and points truncation marker at read_file', async () => {
    setHttpCrawlAPI({
      fetch: vi.fn().mockResolvedValue({
        success: true,
        data: {
          content: GOOD_HTML,
          content_type: 'text/html',
          status_code: 200,
          url: 'https://example.com/article',
          title: 'Example Article',
        },
      }),
    });

    const result = await executeFetchPipeline({
      url: 'https://example.com/article',
      autoFallback: false,
      maxLength: 20,
    });

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[... truncated at 20 of');
    // 完整正文落盘 + 响应回传路径，Agent 用 read_file 无损分段读回
    expect(result.fullContentPath).toBeTruthy();
    expect(result.contentLength).toBeGreaterThan(20);
    expect(result.content).toContain(result.fullContentPath as string);
    expect(result.content).toContain('read_file');

    const persisted = await readFile(result.fullContentPath as string, 'utf8');
    expect(persisted.length).toBe(result.contentLength);
    expect(persisted.startsWith(result.content.slice(0, 20))).toBe(true);
    await rm(result.fullContentPath as string, { force: true });
  });

  it('does not inline truncated body for structured (non-HTML) content', async () => {
    const bigJson = JSON.stringify({
      cik: '0001318605',
      name: 'Tesla, Inc.',
      note: 'x'.repeat(500),
    });
    setHttpCrawlAPI({
      fetch: vi.fn().mockResolvedValue({
        success: true,
        data: {
          content: bigJson,
          content_type: 'application/json',
          status_code: 200,
          url: 'https://data.sec.gov/submissions/CIK0001318605.json',
          title: '',
        },
      }),
    });

    const result = await executeFetchPipeline({
      url: 'https://data.sec.gov/submissions/CIK0001318605.json',
      autoFallback: false,
      maxLength: 50,
    });

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.fullContentPath).toBeTruthy();
    expect(result.contentLength).toBe(bigJson.length);
    // 关键：结构化内容不 inline 截断体——envelope content 短，不含被截断的原始 JSON 头
    expect(result.content.length).toBeLessThan(bigJson.length);
    expect(result.content).not.toContain('0001318605');
    expect(result.content).toContain(result.fullContentPath as string);
    expect(result.content).toContain('read_file');

    const persisted = await readFile(result.fullContentPath as string, 'utf8');
    expect(persisted).toBe(bigJson);
    await rm(result.fullContentPath as string, { force: true });
  });
});
