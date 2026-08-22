import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AssetObjects } from '../assets/types.js';
import { collectSceneAssets, resolveAssets } from '../assets/resolver.js';
import type { MediaResolver } from '../assets/resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 创建一个基础的 image shape */
function imageShape(id: string, src?: string, mediaId?: string, hidden?: boolean) {
  return {
    id,
    type: 'image' as const,
    hidden,
    metadata: {
      ...(src ? { src } : {}),
      ...(mediaId ? { id: mediaId } : {}),
    },
  };
}

/** 创建一个有 fill image 的 shape */
function filledShape(
  id: string,
  fills: Array<{ fillImageId?: string }>,
  opts?: { hidden?: boolean; children?: string[] },
) {
  return {
    id,
    type: 'frame' as const,
    hidden: opts?.hidden,
    fills: fills.map((f) =>
      f.fillImageId ? { fillImage: { id: f.fillImageId } } : {},
    ),
    shapes: opts?.children,
  };
}

/** 创建一个容器 shape */
function containerShape(id: string, childIds: string[], hidden?: boolean) {
  return {
    id,
    type: 'frame' as const,
    hidden,
    shapes: childIds,
  };
}

// ---------------------------------------------------------------------------
// collectSceneAssets
// ---------------------------------------------------------------------------

describe('collectSceneAssets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('基本收集', () => {
    it('收集 image shape 的 src', () => {
      const objects: AssetObjects = {
        img1: imageShape('img1', 'https://cdn.example.com/photo.png'),
      };

      const assets = collectSceneAssets(objects, ['img1']);

      expect(assets).toHaveLength(1);
      expect(assets[0].type).toBe('image');
      expect(assets[0].url).toBe('https://cdn.example.com/photo.png');
      expect(assets[0].shapeId).toBe('img1');
    });

    it('收集 image shape 的 metadata.id（通过 mediaResolver）', () => {
      const objects: AssetObjects = {
        img1: imageShape('img1', undefined, 'media-123'),
      };
      const resolver: MediaResolver = (id) => `https://cdn.example.com/${id}`;

      const assets = collectSceneAssets(objects, ['img1'], resolver);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('https://cdn.example.com/media-123');
    });

    it('收集 fill image', () => {
      const objects: AssetObjects = {
        rect1: filledShape('rect1', [{ fillImageId: 'fill-abc' }]),
      };
      const resolver: MediaResolver = (id) => `https://cdn.example.com/${id}`;

      const assets = collectSceneAssets(objects, ['rect1'], resolver);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('https://cdn.example.com/fill-abc');
      expect(assets[0].key).toBe('fill:fill-abc');
    });

    it('同一 shape 同时有 image src 和 fill image 时都收集', () => {
      const objects: AssetObjects = {
        combo: {
          id: 'combo',
          type: 'image',
          metadata: { src: 'https://cdn.example.com/main.png' },
          fills: [{ fillImage: { id: 'overlay-001' } }],
        },
      };
      const resolver: MediaResolver = (id) => `https://cdn.example.com/${id}`;

      const assets = collectSceneAssets(objects, ['combo'], resolver);

      expect(assets).toHaveLength(2);
      const urls = assets.map((a) => a.url);
      expect(urls).toContain('https://cdn.example.com/main.png');
      expect(urls).toContain('https://cdn.example.com/overlay-001');
    });

    it('没有 metadata 的 image shape 不收集', () => {
      const objects: AssetObjects = {
        empty: { id: 'empty', type: 'image' },
      };

      const assets = collectSceneAssets(objects, ['empty']);
      expect(assets).toHaveLength(0);
    });

    it('不存在的 shapeId 被安全跳过', () => {
      const objects: AssetObjects = {};
      const assets = collectSceneAssets(objects, ['nonexistent']);
      expect(assets).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 嵌套 shape
  // -----------------------------------------------------------------------

  describe('嵌套 shape', () => {
    it('递归收集 children 中的图片', () => {
      const objects: AssetObjects = {
        frame1: containerShape('frame1', ['img1', 'img2']),
        img1: imageShape('img1', 'https://cdn.example.com/a.png'),
        img2: imageShape('img2', 'https://cdn.example.com/b.png'),
      };

      const assets = collectSceneAssets(objects, ['frame1']);

      expect(assets).toHaveLength(2);
      const urls = assets.map((a) => a.url);
      expect(urls).toContain('https://cdn.example.com/a.png');
      expect(urls).toContain('https://cdn.example.com/b.png');
    });

    it('深层嵌套也能收集', () => {
      const objects: AssetObjects = {
        root: containerShape('root', ['group1']),
        group1: containerShape('group1', ['deep-img']),
        'deep-img': imageShape('deep-img', 'https://cdn.example.com/deep.png'),
      };

      const assets = collectSceneAssets(objects, ['root']);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('https://cdn.example.com/deep.png');
    });

    it('container 自身的 fill + children 的 image 都被收集', () => {
      const objects: AssetObjects = {
        frame: filledShape('frame', [{ fillImageId: 'bg-fill' }], {
          children: ['child-img'],
        }),
        'child-img': imageShape('child-img', 'https://cdn.example.com/child.png'),
      };
      const resolver: MediaResolver = (id) => `https://media.example.com/${id}`;

      const assets = collectSceneAssets(objects, ['frame'], resolver);

      expect(assets).toHaveLength(2);
      const urls = assets.map((a) => a.url);
      expect(urls).toContain('https://media.example.com/bg-fill');
      expect(urls).toContain('https://cdn.example.com/child.png');
    });
  });

  // -----------------------------------------------------------------------
  // 去重
  // -----------------------------------------------------------------------

  describe('去重', () => {
    it('同一 URL 在多个 shape 中只返回一次', () => {
      const sharedUrl = 'https://cdn.example.com/shared.png';
      const objects: AssetObjects = {
        img1: imageShape('img1', sharedUrl),
        img2: imageShape('img2', sharedUrl),
      };

      const assets = collectSceneAssets(objects, ['img1', 'img2']);

      // URL 相同，只收集第一次
      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe(sharedUrl);
    });

    it('相同 fillImage.id 只返回一次', () => {
      const objects: AssetObjects = {
        rect1: filledShape('rect1', [{ fillImageId: 'shared-fill' }]),
        rect2: filledShape('rect2', [{ fillImageId: 'shared-fill' }]),
      };
      const resolver: MediaResolver = (id) => `https://cdn.example.com/${id}`;

      const assets = collectSceneAssets(objects, ['rect1', 'rect2'], resolver);

      expect(assets).toHaveLength(1);
    });

    it('同一 shape 多个 fill 使用同一 id 时也去重', () => {
      const objects: AssetObjects = {
        rect: filledShape('rect', [
          { fillImageId: 'dup' },
          { fillImageId: 'dup' },
        ]),
      };
      const resolver: MediaResolver = (id) => `https://cdn.example.com/${id}`;

      const assets = collectSceneAssets(objects, ['rect'], resolver);
      expect(assets).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // hidden shape 跳过
  // -----------------------------------------------------------------------

  describe('hidden shape', () => {
    it('跳过 hidden 的顶层 shape', () => {
      const objects: AssetObjects = {
        img1: imageShape('img1', 'https://cdn.example.com/visible.png'),
        img2: imageShape('img2', 'https://cdn.example.com/hidden.png', undefined, true),
      };

      const assets = collectSceneAssets(objects, ['img1', 'img2']);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('https://cdn.example.com/visible.png');
    });

    it('跳过 hidden 的嵌套 child', () => {
      const objects: AssetObjects = {
        frame: containerShape('frame', ['visible', 'hidden-child']),
        visible: imageShape('visible', 'https://cdn.example.com/yes.png'),
        'hidden-child': imageShape('hidden-child', 'https://cdn.example.com/no.png', undefined, true),
      };

      const assets = collectSceneAssets(objects, ['frame']);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('https://cdn.example.com/yes.png');
    });

    it('hidden 的 container 整个子树被跳过', () => {
      const objects: AssetObjects = {
        hiddenGroup: {
          ...containerShape('hiddenGroup', ['deep']),
          hidden: true,
        },
        deep: imageShape('deep', 'https://cdn.example.com/deep.png'),
      };

      const assets = collectSceneAssets(objects, ['hiddenGroup']);
      expect(assets).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // MediaResolver
  // -----------------------------------------------------------------------

  describe('MediaResolver', () => {
    it('自定义 mediaResolver 转换 URI', () => {
      const objects: AssetObjects = {
        img1: imageShape('img1', undefined, 'raw-id-abc'),
      };
      const resolver: MediaResolver = (id) => `https://custom-cdn.io/v2/${id}.webp`;

      const assets = collectSceneAssets(objects, ['img1'], resolver);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('https://custom-cdn.io/v2/raw-id-abc.webp');
    });

    it('无 mediaResolver 时 metadata.id 直接作为 URL', () => {
      const objects: AssetObjects = {
        img1: imageShape('img1', undefined, 'media-id-xyz'),
      };

      const assets = collectSceneAssets(objects, ['img1']);

      expect(assets).toHaveLength(1);
      expect(assets[0].url).toBe('media-id-xyz');
    });

    it('mediaResolver 同时影响 fill image 和 image shape', () => {
      const objects: AssetObjects = {
        shape1: {
          id: 'shape1',
          type: 'image',
          metadata: { id: 'img-media' },
          fills: [{ fillImage: { id: 'fill-media' } }],
        },
      };
      const resolver: MediaResolver = (id) => `resolved:${id}`;

      const assets = collectSceneAssets(objects, ['shape1'], resolver);

      expect(assets).toHaveLength(2);
      const urls = assets.map((a) => a.url);
      expect(urls).toContain('resolved:img-media');
      expect(urls).toContain('resolved:fill-media');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAssets
// ---------------------------------------------------------------------------

describe('resolveAssets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('调用 imageCache.fetchBatch 获取图片', async () => {
    // mock globalThis.fetch 让 imageCache 内部使用
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      headers: new Headers({ 'content-type': 'image/png' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    const refs = [
      { type: 'image' as const, url: 'https://cdn.example.com/a.png', key: 'img:a' },
      { type: 'image' as const, url: 'https://cdn.example.com/b.png', key: 'img:b' },
    ];

    const results = await resolveAssets(refs);

    expect(results.size).toBe(2);
    expect(results.has('img:a')).toBe(true);
    expect(results.has('img:b')).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('支持 abort signal', async () => {
    const ac = new AbortController();
    ac.abort();

    // 所有 fetch 都应被 abort 掉
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

    const refs = [
      { type: 'image' as const, url: 'https://cdn.example.com/a.png', key: 'img:a' },
    ];

    const results = await resolveAssets(refs, ac.signal);
    // abort 后 fetchBatch 内 early return，结果为空
    expect(results.size).toBe(0);
  });

  it('端到端：collectSceneAssets + resolveAssets 联动', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    } as unknown as Response));

    const objects: AssetObjects = {
      frame: {
        id: 'frame',
        type: 'frame',
        shapes: ['child'],
      },
      child: {
        id: 'child',
        type: 'image',
        metadata: { src: 'https://cdn.example.com/photo.jpg' },
      },
    };

    const refs = collectSceneAssets(objects, ['frame']);
    expect(refs).toHaveLength(1);

    const resolved = await resolveAssets(refs);
    expect(resolved.size).toBe(1);

    const entry = resolved.values().next().value!;
    expect(entry.mimeType).toBe('image/jpeg');
    expect(entry.data.byteLength).toBe(8);
  });
});
