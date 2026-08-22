import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageCache, guessMimeType } from '../assets/image-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFetch(options?: {
  ok?: boolean;
  contentType?: string;
  data?: ArrayBuffer;
}) {
  const ok = options?.ok ?? true;
  const contentType = options?.contentType ?? 'image/png';
  const data = options?.data ?? new ArrayBuffer(4);

  return vi.fn().mockResolvedValue({
    ok,
    blob: () => Promise.resolve(new Blob(['fake'], { type: contentType })),
    arrayBuffer: () => Promise.resolve(data),
    headers: new Headers({ 'content-type': contentType }),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageCache', () => {
  let cache: ImageCache;
  let mockFetch: ReturnType<typeof makeMockFetch>;

  beforeEach(() => {
    cache = new ImageCache({ maxEntries: 256 });
    mockFetch = makeMockFetch();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 基本 fetch
  // -----------------------------------------------------------------------

  describe('基本 fetch', () => {
    it('成功 fetch 并返回 CachedImage 对象', async () => {
      const result = await cache.fetch('https://example.com/img.png');

      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe('image/png');
      expect(result!.data).toBeInstanceOf(ArrayBuffer);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('第二次请求直接从缓存返回，不再调 fetch', async () => {
      await cache.fetch('https://example.com/img.png');
      const result = await cache.fetch('https://example.com/img.png');

      expect(result).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fetch 失败时返回 null', async () => {
      vi.stubGlobal('fetch', makeMockFetch({ ok: false }));

      const result = await cache.fetch('https://example.com/broken.png');
      expect(result).toBeNull();
    });

    it('网络异常时返回 null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')));

      const result = await cache.fetch('https://example.com/fail.png');
      expect(result).toBeNull();
    });

    it('支持自定义 cache key', async () => {
      await cache.fetch('https://example.com/img.png', 'custom-key');

      expect(cache.has('custom-key')).toBe(true);
      expect(cache.has('https://example.com/img.png')).toBe(false);
    });

    it('content-type 从 response header 获取', async () => {
      vi.stubGlobal('fetch', makeMockFetch({ contentType: 'image/webp' }));

      const result = await cache.fetch('https://example.com/photo.webp');
      expect(result!.mimeType).toBe('image/webp');
    });
  });

  // -----------------------------------------------------------------------
  // LRU 淘汰
  // -----------------------------------------------------------------------

  describe('LRU 淘汰', () => {
    it('超过 maxEntries 后淘汰最旧的条目', async () => {
      const smallCache = new ImageCache({ maxEntries: 3 });
      vi.stubGlobal('fetch', makeMockFetch());

      await smallCache.fetch('https://example.com/1.png', 'k1');
      await smallCache.fetch('https://example.com/2.png', 'k2');
      await smallCache.fetch('https://example.com/3.png', 'k3');

      expect(smallCache.size).toBe(3);
      expect(smallCache.has('k1')).toBe(true);

      // 第 4 个条目应淘汰最旧的 k1
      await smallCache.fetch('https://example.com/4.png', 'k4');

      expect(smallCache.size).toBe(3);
      expect(smallCache.has('k1')).toBe(false);
      expect(smallCache.has('k2')).toBe(true);
      expect(smallCache.has('k3')).toBe(true);
      expect(smallCache.has('k4')).toBe(true);
    });

    it('访问旧条目后应更新其 LRU 位置', async () => {
      const smallCache = new ImageCache({ maxEntries: 3 });
      vi.stubGlobal('fetch', makeMockFetch());

      await smallCache.fetch('https://example.com/1.png', 'k1');
      await smallCache.fetch('https://example.com/2.png', 'k2');
      await smallCache.fetch('https://example.com/3.png', 'k3');

      // 访问 k1 使其变为最新
      smallCache.get('k1');

      // 添加 k4，此时最旧的是 k2
      await smallCache.fetch('https://example.com/4.png', 'k4');

      expect(smallCache.has('k1')).toBe(true);
      expect(smallCache.has('k2')).toBe(false); // k2 被淘汰
      expect(smallCache.has('k3')).toBe(true);
      expect(smallCache.has('k4')).toBe(true);
    });

    it('maxBytes 限制也能触发淘汰', async () => {
      // 每个 ArrayBuffer 4 字节，maxBytes 设为 10 字节 => 最多放 2 个
      const tinyCache = new ImageCache({ maxEntries: 100, maxBytes: 10 });
      vi.stubGlobal('fetch', makeMockFetch({ data: new ArrayBuffer(4) }));

      await tinyCache.fetch('https://example.com/1.png', 'k1');
      await tinyCache.fetch('https://example.com/2.png', 'k2');

      expect(tinyCache.size).toBe(2);
      expect(tinyCache.currentBytes).toBe(8);

      await tinyCache.fetch('https://example.com/3.png', 'k3');

      // k1 应该被淘汰，只剩 k2 和 k3
      expect(tinyCache.has('k1')).toBe(false);
      expect(tinyCache.size).toBeLessThanOrEqual(2);
      expect(tinyCache.currentBytes).toBeLessThanOrEqual(10);
    });
  });

  // -----------------------------------------------------------------------
  // 去重
  // -----------------------------------------------------------------------

  describe('请求去重', () => {
    it('并发请求同一 URL 只调一次 fetch', async () => {
      // 创建一个慢 fetch，确保两个请求同时到达
      let resolveResponse!: (value: unknown) => void;
      const slowResponse = new Promise((r) => {
        resolveResponse = r;
      });

      const slowFetch = vi.fn().mockReturnValue(slowResponse);
      vi.stubGlobal('fetch', slowFetch);

      const p1 = cache.fetch('https://example.com/img.png');
      const p2 = cache.fetch('https://example.com/img.png');

      // 此时只发了一次 fetch
      expect(slowFetch).toHaveBeenCalledTimes(1);

      resolveResponse({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        headers: new Headers({ 'content-type': 'image/png' }),
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1).toBe(r2);
    });

    it('不同 URL 不去重', async () => {
      await Promise.all([
        cache.fetch('https://example.com/a.png'),
        cache.fetch('https://example.com/b.png'),
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // fetchBatch
  // -----------------------------------------------------------------------

  describe('fetchBatch', () => {
    it('批量请求多个 URL 并返回结果 Map', async () => {
      const results = await cache.fetchBatch([
        { url: 'https://example.com/a.png' },
        { url: 'https://example.com/b.png' },
        { url: 'https://example.com/c.png', key: 'custom-c' },
      ]);

      expect(results.size).toBe(3);
      expect(results.has('https://example.com/a.png')).toBe(true);
      expect(results.has('https://example.com/b.png')).toBe(true);
      expect(results.has('custom-c')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('部分失败不影响其他请求', async () => {
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({
            ok: false,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          headers: new Headers({ 'content-type': 'image/png' }),
        });
      }));

      const results = await cache.fetchBatch([
        { url: 'https://example.com/a.png', key: 'a' },
        { url: 'https://example.com/fail.png', key: 'fail' },
        { url: 'https://example.com/c.png', key: 'c' },
      ]);

      // 第二个失败，只有 2 个成功
      expect(results.size).toBe(2);
      expect(results.has('a')).toBe(true);
      expect(results.has('c')).toBe(true);
      expect(results.has('fail')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // abort 信号
  // -----------------------------------------------------------------------

  describe('abort 信号', () => {
    it('传入已 abort 的 signal，单独调用者时内部也被 abort', async () => {
      const ac = new AbortController();
      ac.abort();

      // 内部 fetch 的 signal 被 abort -> 会抛异常 -> 返回 null
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          headers: new Headers({ 'content-type': 'image/png' }),
        });
      }));

      const result = await cache.fetch('https://example.com/img.png', undefined, ac.signal);
      expect(result).toBeNull();
    });

    it('abort 后内部代理 signal 也被 abort（单一调用者场景）', async () => {
      const ac = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          if (capturedSignal) {
            capturedSignal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
        });
      }));

      const promise = cache.fetch('https://example.com/img.png', undefined, ac.signal);

      // 发起请求后 abort
      ac.abort();

      const result = await promise;
      expect(result).toBeNull();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('多个调用者中只有一个 abort 不会取消请求', async () => {
      let resolveResponse!: (value: unknown) => void;
      const slowResponse = new Promise((r) => {
        resolveResponse = r;
      });

      let capturedSignal: AbortSignal | undefined;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return slowResponse;
      }));

      const ac1 = new AbortController();
      const p1 = cache.fetch('https://example.com/img.png', undefined, ac1.signal);
      // 第二个调用者没有 signal（permanentCaller）
      const p2 = cache.fetch('https://example.com/img.png');

      // 只 abort 第一个
      ac1.abort();

      // 内部 signal 不应 abort，因为还有 permanent caller
      expect(capturedSignal?.aborted).toBe(false);

      resolveResponse({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        headers: new Headers({ 'content-type': 'image/png' }),
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r2).not.toBeNull();
      // r1 也能收到结果（因为底层 fetch 没被 abort）
      expect(r1).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // set / get / has / evict / clear
  // -----------------------------------------------------------------------

  describe('手动缓存操作', () => {
    it('set 写入后 has 返回 true', () => {
      const img = { data: new ArrayBuffer(8), mimeType: 'image/png' };
      cache.set('my-key', img);

      expect(cache.has('my-key')).toBe(true);
      expect(cache.size).toBe(1);
      expect(cache.currentBytes).toBe(8);
    });

    it('get 返回缓存项', () => {
      const img = { data: new ArrayBuffer(8), mimeType: 'image/jpeg' };
      cache.set('my-key', img);

      const retrieved = cache.get('my-key');
      expect(retrieved).toBeDefined();
      expect(retrieved!.mimeType).toBe('image/jpeg');
    });

    it('get 不存在的 key 返回 undefined', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('clear 清空整个缓存', async () => {
      await cache.fetch('https://example.com/1.png', 'k1');
      await cache.fetch('https://example.com/2.png', 'k2');

      expect(cache.size).toBe(2);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.currentBytes).toBe(0);
      expect(cache.has('k1')).toBe(false);
      expect(cache.has('k2')).toBe(false);
    });

    it('set 覆盖已有 key 时更新 currentBytes', () => {
      cache.set('k', { data: new ArrayBuffer(10), mimeType: 'image/png' });
      expect(cache.currentBytes).toBe(10);

      cache.set('k', { data: new ArrayBuffer(20), mimeType: 'image/png' });
      expect(cache.currentBytes).toBe(20);
      expect(cache.size).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // toDataUri
  // -----------------------------------------------------------------------

  describe('toDataUri', () => {
    it('将缓存项转为 base64 data URI', () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      cache.set('img', { data: bytes.buffer, mimeType: 'image/png' });

      const uri = cache.toDataUri('img');
      expect(uri).not.toBeNull();
      expect(uri!).toMatch(/^data:image\/png;base64,/);
    });

    it('不存在的 key 返回 null', () => {
      expect(cache.toDataUri('nonexistent')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// guessMimeType
// ---------------------------------------------------------------------------

describe('guessMimeType', () => {
  it('.png -> image/png', () => {
    expect(guessMimeType('https://cdn.example.com/photo.png')).toBe('image/png');
  });

  it('.jpg -> image/jpeg', () => {
    expect(guessMimeType('https://cdn.example.com/photo.jpg')).toBe('image/jpeg');
  });

  it('.jpeg -> image/jpeg', () => {
    expect(guessMimeType('https://cdn.example.com/photo.jpeg')).toBe('image/jpeg');
  });

  it('.gif -> image/gif', () => {
    expect(guessMimeType('https://cdn.example.com/anim.gif')).toBe('image/gif');
  });

  it('.webp -> image/webp', () => {
    expect(guessMimeType('https://cdn.example.com/photo.webp')).toBe('image/webp');
  });

  it('.svg -> image/svg+xml', () => {
    expect(guessMimeType('https://cdn.example.com/icon.svg')).toBe('image/svg+xml');
  });

  it('.avif -> image/avif', () => {
    expect(guessMimeType('https://cdn.example.com/photo.avif')).toBe('image/avif');
  });

  it('未知扩展名 -> application/octet-stream', () => {
    expect(guessMimeType('https://cdn.example.com/file.xyz')).toBe('application/octet-stream');
  });

  it('忽略 query string', () => {
    expect(guessMimeType('https://cdn.example.com/photo.png?w=100')).toBe('image/png');
  });

  it('忽略 hash fragment', () => {
    expect(guessMimeType('https://cdn.example.com/photo.jpg#section')).toBe('image/jpeg');
  });

  it('同时有 query 和 hash 也能正确解析', () => {
    expect(guessMimeType('https://cdn.example.com/a.webp?v=2#x')).toBe('image/webp');
  });

  it('无扩展名 -> application/octet-stream', () => {
    expect(guessMimeType('https://cdn.example.com/noext')).toBe('application/octet-stream');
  });
});
