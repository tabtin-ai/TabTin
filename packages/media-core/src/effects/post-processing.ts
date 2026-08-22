/**
 * Post-Processing Pipeline — pre-encode visual effects
 *
 * Leverages our structural advantage: raw RGBA pixel access between render
 * pipeline and FFmpeg encode. Every effect operates in-place on the pixel buffer
 * for zero-allocation performance.
 *
 * ─── Pipeline Order ───────────────────────────────────────────────────────
 *
 *   Renderer → Lottie composite
 *     → Color Grading / LUT  (color transform first — all subsequent effects
 *                              operate on the graded image)
 *     → Bloom / Glow          (extract brights from graded image, blur, add)
 *     → Vignette              (darken edges — after bloom to preserve glow)
 *     → Motion Blur           (temporal blend — last visual effect)
 *     → Anti-banding          (encoding noise — always last)
 *     → FFmpeg encode
 *
 * ─── Built-in LUT Presets ─────────────────────────────────────────────────
 *
 *   'tech-blue'   — Cool blue tint for tech presentations
 *   'warm-sun'    — Warm golden tones, cozy feel
 *   'cyberpunk'   — High contrast + neon teal/magenta split tones
 *   'cinematic'   — S-curve contrast + slight desaturation
 *   'vintage'     — Faded warm look with lifted blacks
 *
 * ─── .cube LUT Support ───────────────────────────────────────────────────
 *
 *   Industry-standard 3D LUT format (DaVinci Resolve, Premiere, FCPX).
 *   Parsed once, applied per-pixel via trilinear interpolation.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ColorGradingPreset =
  | 'tech-blue'
  | 'warm-sun'
  | 'cyberpunk'
  | 'cinematic'
  | 'vintage';

export interface ColorGradingOptions {
  /** Built-in preset name. Mutually exclusive with `cubeLutData`. */
  preset?: ColorGradingPreset;

  /**
   * Raw .cube LUT file content (string).
   * Takes precedence over `preset` if both are provided.
   */
  cubeLutData?: string;

  /**
   * Blend intensity of the color grading effect.
   * 0 = original, 1 = full effect. Default: 1.0
   */
  intensity?: number;

  /** Brightness adjustment (-1 to 1). Default: 0 */
  brightness?: number;

  /** Contrast adjustment (-1 to 1). Default: 0 */
  contrast?: number;

  /** Saturation multiplier (0 = grayscale, 1 = normal, 2 = oversaturated). Default: 1 */
  saturation?: number;

  /** Color temperature shift (-1 = cool/blue, +1 = warm/amber). Default: 0 */
  temperature?: number;
}

export interface VignetteOptions {
  /** Darkening strength at corners. Range: 0-1. Default: 0.4 */
  strength?: number;

  /**
   * Radius of the un-vignetted center area (0-1 normalized to half-diagonal).
   * Default: 0.5 — vignette starts halfway to corners.
   */
  radius?: number;

  /** Softness of the vignette falloff. Higher = smoother. Default: 0.5 */
  softness?: number;
}

export interface BloomOptions {
  /**
   * Luminance threshold for bloom extraction.
   * Pixels brighter than this contribute to bloom. Range: 0-1. Default: 0.7
   */
  threshold?: number;

  /** Blur radius in pixels. Higher = wider glow. Default: 20 */
  radius?: number;

  /** Bloom intensity multiplier. Range: 0-2. Default: 0.4 */
  intensity?: number;
}

export interface MotionBlurOptions {
  /**
   * Blend factor for temporal accumulation.
   * 0 = no blur, 1 = maximum trailing. Default: 0.3
   */
  strength?: number;
}

export interface PostProcessingOptions {
  /** Master switch. Default: false (opt-in) */
  enabled?: boolean;

  colorGrading?: ColorGradingOptions;
  vignette?: VignetteOptions;
  bloom?: BloomOptions;
  motionBlur?: MotionBlurOptions;
}

export interface ResolvedPostProcessingOptions {
  enabled: boolean;
  colorGrading: Required<Omit<ColorGradingOptions, 'cubeLutData' | 'preset'>> & {
    preset?: ColorGradingPreset;
    cubeLutData?: string;
    _lut3d?: Lut3D;
  };
  vignette: Required<VignetteOptions> & { _enabled: boolean };
  bloom: Required<BloomOptions> & { _enabled: boolean };
  motionBlur: Required<MotionBlurOptions> & { _enabled: boolean };
}

// ---------------------------------------------------------------------------
// Resolve defaults
// ---------------------------------------------------------------------------

export function resolvePostProcessingOptions(
  opts?: PostProcessingOptions,
): ResolvedPostProcessingOptions {
  if (!opts || !opts.enabled) {
    return {
      enabled: false,
      colorGrading: { intensity: 1, brightness: 0, contrast: 0, saturation: 1, temperature: 0 },
      vignette: { strength: 0.4, radius: 0.5, softness: 0.5, _enabled: false },
      bloom: { threshold: 0.7, radius: 20, intensity: 0.4, _enabled: false },
      motionBlur: { strength: 0.3, _enabled: false },
    };
  }

  const cg = opts.colorGrading;

  const resolvedCg: ResolvedPostProcessingOptions['colorGrading'] = {
    preset: cg?.preset,
    cubeLutData: cg?.cubeLutData,
    intensity: cg?.intensity ?? 1,
    brightness: cg?.brightness ?? 0,
    contrast: cg?.contrast ?? 0,
    saturation: cg?.saturation ?? 1,
    temperature: cg?.temperature ?? 0,
  };

  if (cg?.cubeLutData) {
    resolvedCg._lut3d = parseCubeLut(cg.cubeLutData);
  } else if (cg?.preset) {
    resolvedCg._lut3d = undefined; // preset uses curve-based grading
  }

  return {
    enabled: true,
    colorGrading: resolvedCg,
    vignette: {
      strength: opts.vignette?.strength ?? 0.4,
      radius: opts.vignette?.radius ?? 0.5,
      softness: opts.vignette?.softness ?? 0.5,
      _enabled: !!opts.vignette,
    },
    bloom: {
      threshold: opts.bloom?.threshold ?? 0.7,
      radius: opts.bloom?.radius ?? 20,
      intensity: opts.bloom?.intensity ?? 0.4,
      _enabled: !!opts.bloom,
    },
    motionBlur: {
      strength: opts.motionBlur?.strength ?? 0.3,
      _enabled: !!opts.motionBlur,
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline state (motion blur frame accumulator)
// ---------------------------------------------------------------------------

export class PostProcessingState {
  private prevFrame: Float32Array | null = null;

  reset(): void {
    this.prevFrame = null;
  }

  getPrevFrame(): Float32Array | null {
    // Return a copy to prevent storePrevFrame() from aliasing the reference
    return this.prevFrame ? new Float32Array(this.prevFrame) : null;
  }

  storePrevFrame(pixels: Uint8Array): void {
    if (!this.prevFrame || this.prevFrame.length !== pixels.length) {
      this.prevFrame = new Float32Array(pixels.length);
    }
    for (let i = 0; i < pixels.length; i++) {
      this.prevFrame[i] = pixels[i];
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point — called per frame
// ---------------------------------------------------------------------------

/**
 * Apply post-processing effects to a raw RGBA pixel buffer.
 * Mutates pixels in-place. Effects are applied in optimal order.
 */
export function applyPostProcessing(
  pixels: Uint8Array,
  width: number,
  height: number,
  _frameIndex: number,
  options: ResolvedPostProcessingOptions,
  state: PostProcessingState,
): void {
  if (!options.enabled) return;

  const hasColorGrading = !!(
    options.colorGrading.preset ||
    options.colorGrading._lut3d ||
    options.colorGrading.brightness !== 0 ||
    options.colorGrading.contrast !== 0 ||
    options.colorGrading.temperature !== 0 ||
    options.colorGrading.saturation !== 1
  );

  // 1. Color Grading / LUT
  if (hasColorGrading) {
    applyColorGrading(pixels, width, height, options.colorGrading);
  }

  // 2. Bloom / Glow
  if (options.bloom._enabled) {
    applyBloom(pixels, width, height, options.bloom);
  }

  // 3. Vignette
  if (options.vignette._enabled) {
    applyVignette(pixels, width, height, options.vignette);
  }

  // 4. Motion Blur (temporal accumulation)
  if (options.motionBlur._enabled) {
    applyMotionBlur(pixels, width, height, options.motionBlur, state);
  }
}

// ---------------------------------------------------------------------------
// 1. Color Grading / LUT
// ---------------------------------------------------------------------------

function applyColorGrading(
  pixels: Uint8Array,
  width: number,
  height: number,
  opts: ResolvedPostProcessingOptions['colorGrading'],
): void {
  const len = width * height * 4;
  const intensity = opts.intensity;

  for (let i = 0; i < len; i += 4) {
    let r = pixels[i] / 255;
    let g = pixels[i + 1] / 255;
    let b = pixels[i + 2] / 255;

    const origR = r;
    const origG = g;
    const origB = b;

    // 3D LUT lookup (highest priority)
    if (opts._lut3d) {
      const graded = trilinearLookup(opts._lut3d, r, g, b);
      r = graded[0];
      g = graded[1];
      b = graded[2];
    }
    // Preset curve-based grading
    else if (opts.preset) {
      const graded = applyPresetCurves(opts.preset, r, g, b);
      r = graded[0];
      g = graded[1];
      b = graded[2];
    }

    // Brightness
    if (opts.brightness !== 0) {
      r += opts.brightness;
      g += opts.brightness;
      b += opts.brightness;
    }

    // Contrast (pivot at 0.5)
    if (opts.contrast !== 0) {
      const c = 1 + opts.contrast;
      r = (r - 0.5) * c + 0.5;
      g = (g - 0.5) * c + 0.5;
      b = (b - 0.5) * c + 0.5;
    }

    // Saturation (luminance-preserving)
    if (opts.saturation !== 1) {
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = lum + (r - lum) * opts.saturation;
      g = lum + (g - lum) * opts.saturation;
      b = lum + (b - lum) * opts.saturation;
    }

    // Temperature (simple warm/cool shift)
    if (opts.temperature !== 0) {
      const t = opts.temperature * 0.1;
      r += t;
      b -= t;
    }

    // Blend with original
    if (intensity < 1) {
      r = origR + (r - origR) * intensity;
      g = origG + (g - origG) * intensity;
      b = origB + (b - origB) * intensity;
    }

    pixels[i]     = clamp8(r * 255);
    pixels[i + 1] = clamp8(g * 255);
    pixels[i + 2] = clamp8(b * 255);
  }
}

// ---------------------------------------------------------------------------
// Preset color curves
// ---------------------------------------------------------------------------

function applyPresetCurves(preset: ColorGradingPreset, r: number, g: number, b: number): [number, number, number] {
  switch (preset) {
    case 'tech-blue': {
      // Cool blue tint, slight desaturation, lifted shadows
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = lum + (r - lum) * 0.85;
      g = lum + (g - lum) * 0.9;
      b = lum + (b - lum) * 1.15;
      r = sCurve(r, 1.1);
      g = sCurve(g, 1.05);
      b = sCurve(b, 1.2);
      r = r * 0.92 + 0.02;
      g = g * 0.95 + 0.02;
      b = b * 1.05 + 0.04;
      return [r, g, b];
    }

    case 'warm-sun': {
      // Golden warmth, slight orange push
      r = sCurve(r, 1.15);
      g = sCurve(g, 1.05);
      b = sCurve(b, 0.95);
      r = r * 1.08 + 0.02;
      g = g * 1.02 + 0.01;
      b = b * 0.88;
      return [r, g, b];
    }

    case 'cyberpunk': {
      // High contrast, teal shadows + magenta highlights
      r = sCurve(r, 1.4);
      g = sCurve(g, 1.3);
      b = sCurve(b, 1.3);
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      // Teal in shadows, magenta in highlights
      if (lum < 0.5) {
        r *= 0.85;
        g = g * 0.95 + 0.03;
        b = b * 1.1 + 0.05;
      } else {
        r = r * 1.1 + 0.03;
        g *= 0.9;
        b = b * 1.05 + 0.02;
      }
      return [r, g, b];
    }

    case 'cinematic': {
      // S-curve contrast + slight desaturation + orange-teal
      r = sCurve(r, 1.25);
      g = sCurve(g, 1.2);
      b = sCurve(b, 1.2);
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = lum + (r - lum) * 0.9;
      g = lum + (g - lum) * 0.88;
      b = lum + (b - lum) * 0.92;
      // Warm highlights, cool shadows
      if (lum < 0.4) {
        b += 0.02;
      } else {
        r += 0.02;
        g += 0.01;
      }
      return [r, g, b];
    }

    case 'vintage': {
      // Faded look: lifted blacks, warm tint, reduced contrast
      const lift = 0.06;
      r = lift + r * (1 - lift * 1.5);
      g = lift + g * (1 - lift * 1.8);
      b = lift * 0.7 + b * (1 - lift * 2.0);
      // Slight warm push
      r *= 1.05;
      g *= 0.98;
      b *= 0.90;
      // Reduced saturation
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = lum + (r - lum) * 0.75;
      g = lum + (g - lum) * 0.75;
      b = lum + (b - lum) * 0.75;
      return [r, g, b];
    }

    default:
      return [r, g, b];
  }
}

/**
 * Attempt an S-curve (sigmoid) contrast enhancement.
 * `strength` > 1 increases contrast, < 1 reduces it.
 */
function sCurve(x: number, strength: number): number {
  // Attempt parameterized sigmoid: map [0,1] → [0,1] with variable steepness
  const k = strength * 4;
  return 1 / (1 + Math.exp(-k * (x - 0.5)));
}

// ---------------------------------------------------------------------------
// 2. Bloom / Glow
// ---------------------------------------------------------------------------

function applyBloom(
  pixels: Uint8Array,
  width: number,
  height: number,
  opts: Required<BloomOptions>,
): void {
  const len = width * height;
  const threshold = opts.threshold * 255;
  const radius = Math.max(1, Math.round(opts.radius));
  const intensity = opts.intensity;

  // Extract bright pixels into a separate buffer (single channel luminance)
  const bright = new Float32Array(len * 3);
  for (let i = 0; i < len; i++) {
    const pi = i * 4;
    const lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
    if (lum > threshold) {
      const factor = (lum - threshold) / (255 - threshold);
      bright[i * 3]     = pixels[pi]     * factor;
      bright[i * 3 + 1] = pixels[pi + 1] * factor;
      bright[i * 3 + 2] = pixels[pi + 2] * factor;
    }
  }

  // Multi-pass box blur (3 passes ≈ Gaussian)
  const temp = new Float32Array(len * 3);
  boxBlurRGB(bright, temp, width, height, radius);
  boxBlurRGB(temp, bright, width, height, radius);
  boxBlurRGB(bright, temp, width, height, radius);

  // Additive composite
  for (let i = 0; i < len; i++) {
    const pi = i * 4;
    const br = temp[i * 3]     * intensity;
    const bg = temp[i * 3 + 1] * intensity;
    const bb = temp[i * 3 + 2] * intensity;

    pixels[pi]     = clamp8(pixels[pi]     + br);
    pixels[pi + 1] = clamp8(pixels[pi + 1] + bg);
    pixels[pi + 2] = clamp8(pixels[pi + 2] + bb);
  }
}

/**
 * Separable box blur on an RGB float buffer (3 floats per pixel).
 * Two-pass: horizontal then vertical.
 */
function boxBlurRGB(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const iarr = 1 / (radius + radius + 1);

  // Horizontal pass → intermediate storage in dst
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 3;
    let rSum = 0, gSum = 0, bSum = 0;

    // Seed the running sum with left edge values
    for (let x = -radius; x <= radius; x++) {
      const cx = Math.min(Math.max(x, 0), width - 1);
      const idx = rowOff + cx * 3;
      rSum += src[idx];
      gSum += src[idx + 1];
      bSum += src[idx + 2];
    }

    for (let x = 0; x < width; x++) {
      const outIdx = rowOff + x * 3;
      dst[outIdx]     = rSum * iarr;
      dst[outIdx + 1] = gSum * iarr;
      dst[outIdx + 2] = bSum * iarr;

      // Slide window: add right, subtract left
      const addX = Math.min(x + radius + 1, width - 1);
      const subX = Math.max(x - radius, 0);
      const addIdx = rowOff + addX * 3;
      const subIdx = rowOff + subX * 3;
      rSum += src[addIdx]     - src[subIdx];
      gSum += src[addIdx + 1] - src[subIdx + 1];
      bSum += src[addIdx + 2] - src[subIdx + 2];
    }
  }

  // Vertical pass: read from dst (horizontal result), write back to dst via src as temp
  // We'll read from dst and write to src, then copy back
  for (let x = 0; x < width; x++) {
    let rSum = 0, gSum = 0, bSum = 0;

    for (let y = -radius; y <= radius; y++) {
      const cy = Math.min(Math.max(y, 0), height - 1);
      const idx = (cy * width + x) * 3;
      rSum += dst[idx];
      gSum += dst[idx + 1];
      bSum += dst[idx + 2];
    }

    for (let y = 0; y < height; y++) {
      const outIdx = (y * width + x) * 3;
      src[outIdx]     = rSum * iarr;
      src[outIdx + 1] = gSum * iarr;
      src[outIdx + 2] = bSum * iarr;

      const addY = Math.min(y + radius + 1, height - 1);
      const subY = Math.max(y - radius, 0);
      const addIdx = (addY * width + x) * 3;
      const subIdx = (subY * width + x) * 3;
      rSum += dst[addIdx]     - dst[subIdx];
      gSum += dst[addIdx + 1] - dst[subIdx + 1];
      bSum += dst[addIdx + 2] - dst[subIdx + 2];
    }
  }

  // Copy result from src back to dst
  dst.set(src);
}

// ---------------------------------------------------------------------------
// 3. Vignette
// ---------------------------------------------------------------------------

function applyVignette(
  pixels: Uint8Array,
  width: number,
  height: number,
  opts: Required<VignetteOptions>,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const { strength, radius, softness } = opts;
  const innerRadius = radius * maxDist;
  const outerRadius = innerRadius + softness * maxDist;

  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= innerRadius) continue;

      let factor: number;
      if (dist >= outerRadius) {
        factor = 1 - strength;
      } else {
        // Smooth interpolation between inner and outer radius
        const t = (dist - innerRadius) / (outerRadius - innerRadius);
        // Smoothstep for natural falloff
        const smooth = t * t * (3 - 2 * t);
        factor = 1 - strength * smooth;
      }

      const i = (y * width + x) * 4;
      pixels[i]     = clamp8(pixels[i]     * factor);
      pixels[i + 1] = clamp8(pixels[i + 1] * factor);
      pixels[i + 2] = clamp8(pixels[i + 2] * factor);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Motion Blur (temporal accumulation)
// ---------------------------------------------------------------------------

function applyMotionBlur(
  pixels: Uint8Array,
  _width: number,
  _height: number,
  opts: Required<MotionBlurOptions>,
  state: PostProcessingState,
): void {
  const prevFrame = state.getPrevFrame();
  const blendFactor = opts.strength;

  // Store current frame before blending
  state.storePrevFrame(pixels);

  if (!prevFrame) return; // First frame — no history

  const len = pixels.length;
  const keep = 1 - blendFactor;

  for (let i = 0; i < len; i += 4) {
    pixels[i]     = clamp8(pixels[i]     * keep + prevFrame[i]     * blendFactor);
    pixels[i + 1] = clamp8(pixels[i + 1] * keep + prevFrame[i + 1] * blendFactor);
    pixels[i + 2] = clamp8(pixels[i + 2] * keep + prevFrame[i + 2] * blendFactor);
    // Alpha channel unchanged
  }
}

// ---------------------------------------------------------------------------
// 3D LUT (.cube) Parser
// ---------------------------------------------------------------------------

export interface Lut3D {
  size: number;
  data: Float32Array; // size^3 * 3 entries (RGB triplets)
}

/**
 * Parse an Adobe/Resolve .cube LUT file.
 *
 * Supported directives: TITLE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX, data lines.
 * Comments (lines starting with #) are skipped.
 */
export function parseCubeLut(content: string): Lut3D {
  const lines = content.split('\n');
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values: number[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;

    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (line.startsWith('DOMAIN_MIN')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      domainMin = [parts[0], parts[1], parts[2]];
      continue;
    }
    if (line.startsWith('DOMAIN_MAX')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      domainMax = [parts[0], parts[1], parts[2]];
      continue;
    }

    // Data line: R G B
    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const r = (parseFloat(parts[0]) - domainMin[0]) / (domainMax[0] - domainMin[0]);
      const g = (parseFloat(parts[1]) - domainMin[1]) / (domainMax[1] - domainMin[1]);
      const b = (parseFloat(parts[2]) - domainMin[2]) / (domainMax[2] - domainMin[2]);
      values.push(r, g, b);
    }
  }

  if (size === 0) throw new Error('Invalid .cube LUT: missing LUT_3D_SIZE');
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(`Invalid .cube LUT: expected ${expected} values, got ${values.length}`);
  }

  return { size, data: new Float32Array(values) };
}

/**
 * Trilinear interpolation in a 3D LUT cube.
 * Input r, g, b are in [0, 1]. Returns [r, g, b] in [0, 1].
 */
function trilinearLookup(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const s = lut.size - 1;
  const data = lut.data;

  // Scale to LUT indices
  const ri = r * s;
  const gi = g * s;
  const bi = b * s;

  const r0 = Math.min(Math.floor(ri), s);
  const g0 = Math.min(Math.floor(gi), s);
  const b0 = Math.min(Math.floor(bi), s);
  const r1 = Math.min(r0 + 1, s);
  const g1 = Math.min(g0 + 1, s);
  const b1 = Math.min(b0 + 1, s);

  const rd = ri - r0;
  const gd = gi - g0;
  const bd = bi - b0;

  // .cube file order: R varies fastest, then G, then B
  const idx = (bv: number, gv: number, rv: number) => (bv * lut.size * lut.size + gv * lut.size + rv) * 3;

  // 8 corner lookups
  const c000 = idx(b0, g0, r0);
  const c100 = idx(b0, g0, r1);
  const c010 = idx(b0, g1, r0);
  const c110 = idx(b0, g1, r1);
  const c001 = idx(b1, g0, r0);
  const c101 = idx(b1, g0, r1);
  const c011 = idx(b1, g1, r0);
  const c111 = idx(b1, g1, r1);

  // Trilinear interpolation for each channel
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const v000 = data[c000 + ch];
    const v100 = data[c100 + ch];
    const v010 = data[c010 + ch];
    const v110 = data[c110 + ch];
    const v001 = data[c001 + ch];
    const v101 = data[c101 + ch];
    const v011 = data[c011 + ch];
    const v111 = data[c111 + ch];

    const c00 = v000 + (v100 - v000) * rd;
    const c10 = v010 + (v110 - v010) * rd;
    const c01 = v001 + (v101 - v001) * rd;
    const c11 = v011 + (v111 - v011) * rd;

    const c0 = c00 + (c10 - c00) * gd;
    const c1 = c01 + (c11 - c01) * gd;

    out[ch] = c0 + (c1 - c0) * bd;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}
