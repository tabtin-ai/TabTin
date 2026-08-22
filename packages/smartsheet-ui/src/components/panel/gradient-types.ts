/**
 * Gradient data types — shared across design-engine, tabslide, etc.
 */

export type HexColor = string;

export type GradientType = 'linear' | 'radial' | 'angular' | 'diamond';

export interface GradientStop {
  color: HexColor;
  opacity?: number; // 0-1
  offset: number;   // 0-1
}

export interface Gradient {
  type: GradientType;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  stops: GradientStop[];
}
