export interface IAutoSize {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  lineHeight?: number;
}

export const MeasuredCanvas = (defaults: IAutoSize = {}) => {
  const {
    fontFamily = 'Inter, Roboto, -apple-system, BlinkMacSystemFont, avenir next, avenir, segoe ui, helvetica neue, helvetica, Ubuntu, noto, arial, sans-serif',
    fontWeight = '400',
    fontStyle = 'normal',
  } = defaults;
  if (typeof window === 'undefined' || document?.fonts?.ready == null) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas?.getContext('2d') ?? null;
  if (!ctx) return;

  const setFontSize = (fontSize: number) => {
    if (ctx) {
      ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    }
  };

  const reset = () => setFontSize(13);
  setFontSize(13);

  return {
    ctx,
    reset,
    setFontSize,
  };
};

export const measuredCanvas = MeasuredCanvas();
