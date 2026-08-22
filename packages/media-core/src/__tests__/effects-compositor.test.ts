import { describe, it, expect } from 'vitest';
import { compositeOverlay, compositeFrame, type OverlayBuffer } from '../effects/compositor.js';

/**
 * 辅助函数：创建纯色 RGBA 缓冲区
 */
function solidBuffer(width: number, height: number, r: number, g: number, b: number, a: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

/**
 * 辅助函数：获取指定像素的 RGBA 值
 */
function getPixel(buf: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

describe('合成器 (Compositor)', () => {
  describe('compositeOverlay', () => {
    it('全透明 overlay（alpha=0）不改变底层', () => {
      const base = solidBuffer(4, 4, 100, 150, 200, 255);
      const baseCopy = new Uint8Array(base);
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(4, 4, 255, 0, 0, 0), // alpha=0
        width: 4,
        height: 4,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      compositeOverlay(base, 4, 4, overlay);
      expect(base).toEqual(baseCopy);
    });

    it('opacity=0 的 overlay 不改变底层', () => {
      const base = solidBuffer(4, 4, 100, 150, 200, 255);
      const baseCopy = new Uint8Array(base);
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(4, 4, 255, 0, 0, 255),
        width: 4,
        height: 4,
        x: 0,
        y: 0,
        opacity: 0,
      };

      compositeOverlay(base, 4, 4, overlay);
      expect(base).toEqual(baseCopy);
    });

    it('完全不透明 overlay（alpha=255, opacity=1）完全覆盖底层', () => {
      const base = solidBuffer(2, 2, 0, 0, 0, 255);
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(2, 2, 255, 128, 64, 255),
        width: 2,
        height: 2,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      compositeOverlay(base, 2, 2, overlay);

      const [r, g, b, a] = getPixel(base, 2, 0, 0);
      expect(r).toBe(255);
      expect(g).toBe(128);
      expect(b).toBe(64);
      expect(a).toBe(255);
    });

    it('半透明 overlay 进行 alpha 混合', () => {
      // 底层：纯黑 (0,0,0,255)
      const base = solidBuffer(1, 1, 0, 0, 0, 255);
      // overlay：纯白 (255,255,255,128) — 约 50% 透明
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(1, 1, 255, 255, 255, 128),
        width: 1,
        height: 1,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      compositeOverlay(base, 1, 1, overlay);

      const [r, g, b, a] = getPixel(base, 1, 0, 0);
      // 结果应该在黑白之间（约 128 左右）
      expect(r).toBeGreaterThan(100);
      expect(r).toBeLessThan(160);
      expect(g).toBeGreaterThan(100);
      expect(b).toBeGreaterThan(100);
      expect(a).toBe(255);
    });

    it('overlay 带偏移量时只影响重叠区域', () => {
      // 4x4 底层纯黑
      const base = solidBuffer(4, 4, 0, 0, 0, 255);
      // 2x2 红色 overlay 放在 (2,2)
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(2, 2, 255, 0, 0, 255),
        width: 2,
        height: 2,
        x: 2,
        y: 2,
        opacity: 1.0,
      };

      compositeOverlay(base, 4, 4, overlay);

      // (0,0) 未受影响
      expect(getPixel(base, 4, 0, 0)).toEqual([0, 0, 0, 255]);
      // (1,1) 未受影响
      expect(getPixel(base, 4, 1, 1)).toEqual([0, 0, 0, 255]);
      // (2,2) 被覆盖为红色
      expect(getPixel(base, 4, 2, 2)).toEqual([255, 0, 0, 255]);
      // (3,3) 也被覆盖为红色
      expect(getPixel(base, 4, 3, 3)).toEqual([255, 0, 0, 255]);
    });

    it('overlay 超出底层边界时裁剪', () => {
      const base = solidBuffer(2, 2, 0, 0, 0, 255);
      // 4x4 overlay 放在 (-1, -1)，只有右下角的 2x2 重叠
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(4, 4, 255, 0, 0, 255),
        width: 4,
        height: 4,
        x: -1,
        y: -1,
        opacity: 1.0,
      };

      // 不应该抛出错误
      compositeOverlay(base, 2, 2, overlay);

      // 所有像素都应该变红（因为 overlay 足够大覆盖整个 base）
      expect(getPixel(base, 2, 0, 0)).toEqual([255, 0, 0, 255]);
      expect(getPixel(base, 2, 1, 1)).toEqual([255, 0, 0, 255]);
    });

    it('overlay 完全在底层外面时不改变底层', () => {
      const base = solidBuffer(2, 2, 100, 100, 100, 255);
      const baseCopy = new Uint8Array(base);
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(2, 2, 255, 0, 0, 255),
        width: 2,
        height: 2,
        x: 10,
        y: 10,
        opacity: 1.0,
      };

      compositeOverlay(base, 2, 2, overlay);
      expect(base).toEqual(baseCopy);
    });
  });

  describe('compositeFrame', () => {
    it('按顺序合成多个 overlay', () => {
      const base = solidBuffer(2, 2, 0, 0, 0, 255);

      // 第一层：红色（半透明）
      const red: OverlayBuffer = {
        pixels: solidBuffer(2, 2, 255, 0, 0, 128),
        width: 2,
        height: 2,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      // 第二层：绿色（完全不透明）覆盖
      const green: OverlayBuffer = {
        pixels: solidBuffer(2, 2, 0, 255, 0, 255),
        width: 2,
        height: 2,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      compositeFrame(base, 2, 2, [red, green]);

      // 最终结果应该是绿色（因为绿色层完全不透明覆盖）
      const [r, g, b] = getPixel(base, 2, 0, 0);
      expect(r).toBe(0);
      expect(g).toBe(255);
      expect(b).toBe(0);
    });

    it('空 overlay 数组不改变底层', () => {
      const base = solidBuffer(2, 2, 100, 100, 100, 255);
      const baseCopy = new Uint8Array(base);

      compositeFrame(base, 2, 2, []);
      expect(base).toEqual(baseCopy);
    });

    it('单个 overlay 等同于直接 compositeOverlay', () => {
      const base1 = solidBuffer(2, 2, 50, 50, 50, 255);
      const base2 = solidBuffer(2, 2, 50, 50, 50, 255);

      const overlay: OverlayBuffer = {
        pixels: solidBuffer(2, 2, 200, 100, 50, 200),
        width: 2,
        height: 2,
        x: 0,
        y: 0,
        opacity: 0.8,
      };

      compositeOverlay(base1, 2, 2, overlay);
      compositeFrame(base2, 2, 2, [{ ...overlay, pixels: new Uint8Array(overlay.pixels) }]);

      expect(base1).toEqual(base2);
    });
  });

  describe('边界情况', () => {
    it('1x1 像素的 base 和 overlay', () => {
      const base = solidBuffer(1, 1, 0, 0, 0, 255);
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(1, 1, 128, 64, 32, 255),
        width: 1,
        height: 1,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      compositeOverlay(base, 1, 1, overlay);
      expect(getPixel(base, 1, 0, 0)).toEqual([128, 64, 32, 255]);
    });

    it('base alpha=0 上叠加不透明 overlay', () => {
      const base = solidBuffer(1, 1, 0, 0, 0, 0); // 完全透明
      const overlay: OverlayBuffer = {
        pixels: solidBuffer(1, 1, 200, 100, 50, 255),
        width: 1,
        height: 1,
        x: 0,
        y: 0,
        opacity: 1.0,
      };

      compositeOverlay(base, 1, 1, overlay);
      const [r, g, b, a] = getPixel(base, 1, 0, 0);
      expect(r).toBe(200);
      expect(g).toBe(100);
      expect(b).toBe(50);
      expect(a).toBe(255);
    });
  });
});
