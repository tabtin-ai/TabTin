/**
 * Frame Compositor — alpha-blend overlay RGBA buffers onto a base frame.
 *
 * Uses standard "source over" compositing (premultiplied alpha).
 * Designed for offline video rendering — not optimized for real-time.
 */

export interface OverlayBuffer {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Position on the base canvas */
  x: number;
  y: number;
  /** Global opacity multiplier (0-1) */
  opacity: number;
}

/**
 * Composite an overlay onto a base RGBA buffer (mutates base in-place).
 *
 * Both buffers are RGBA (4 bytes per pixel). The overlay is placed at
 * (overlay.x, overlay.y) relative to the base canvas.
 */
export function compositeOverlay(
  base: Uint8Array,
  baseWidth: number,
  baseHeight: number,
  overlay: OverlayBuffer,
): void {
  const { pixels: ovr, width: oW, height: oH, x: ox, y: oy, opacity } = overlay;
  if (opacity <= 0) return;

  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(baseWidth, ox + oW);
  const y1 = Math.min(baseHeight, oy + oH);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const bi = (y * baseWidth + x) * 4;
      const oi = ((y - oy) * oW + (x - ox)) * 4;

      const sa = (ovr[oi + 3] / 255) * opacity;
      if (sa <= 0) continue;

      const da = base[bi + 3] / 255;
      const outA = sa + da * (1 - sa);

      if (outA > 0) {
        const invOutA = 1 / outA;
        base[bi]     = (ovr[oi]     * sa + base[bi]     * da * (1 - sa)) * invOutA;
        base[bi + 1] = (ovr[oi + 1] * sa + base[bi + 1] * da * (1 - sa)) * invOutA;
        base[bi + 2] = (ovr[oi + 2] * sa + base[bi + 2] * da * (1 - sa)) * invOutA;
        base[bi + 3] = outA * 255;
      }
    }
  }
}

/**
 * Composite multiple overlays onto a base frame (mutates base in-place).
 * Overlays are applied in array order (first = bottom, last = top).
 */
export function compositeFrame(
  base: Uint8Array,
  baseWidth: number,
  baseHeight: number,
  overlays: OverlayBuffer[],
): void {
  for (const overlay of overlays) {
    compositeOverlay(base, baseWidth, baseHeight, overlay);
  }
}
