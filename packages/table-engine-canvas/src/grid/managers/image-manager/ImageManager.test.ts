import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageManager } from './ImageManager';

describe('ImageManager resolved image URLs', () => {
  const originalImage = globalThis.Image;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  afterEach(() => {
    globalThis.Image = originalImage;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    vi.restoreAllMocks();
  });

  it('resolves a private URL before assigning the image source', async () => {
    let assignedSrc = '';

    class FakeImage {
      private loadListeners: Array<() => void> = [];

      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.loadListeners.push(listener);
      }

      set src(value: string) {
        assignedSrc = value;
        queueMicrotask(() => this.loadListeners.forEach((listener) => listener()));
      }

      get src() {
        return assignedSrc;
      }

      async decode() {}
    }

    globalThis.Image = FakeImage as unknown as typeof Image;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;

    const resolveUrl = vi.fn(async () => 'blob:resolved-private-image');
    const manager = new ImageManager();

    (manager.loadOrGetImage as any)('https://private.example/image.jpg', 0, 0, {
      cacheKey: 'file-id-1',
      resolveUrl,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveUrl).toHaveBeenCalledOnce();
    expect(assignedSrc).toBe('blob:resolved-private-image');
  });
});
