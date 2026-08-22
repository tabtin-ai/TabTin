export type {
  OrbTexture,
  OrbMode,
  OrbPresetSize,
  OrbDotTone,
  OrbVisual,
  OrbRgb,
  OrbPaintOptions,
  OrbPreset,
  OrbInk,
  OrbInkColor,
  OrbDot,
  OrbLine,
  OrbFrame,
  OrbPaintInput,
  OrbSettleShape,
  OrbResolveKind,
  OrbResolveState,
  OrbClockState,
} from './types.js';

export { resolveOrbVisual, resolveOrbPreset, pickOrbPresetSize } from './presets.js';
export { buildOrbFrame, resolveOrbDotInk, resolveOrbLineInk } from './painter.js';
export {
  createOrbClock,
  advanceOrbClock,
  beginOrbResolve,
  settleOrbClock,
  isOrbResting,
} from './lifecycle.js';
