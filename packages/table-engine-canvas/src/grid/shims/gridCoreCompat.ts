/**
 * Lightweight runtime replacements for the few core helper shims used by the
 * renderer. Keeping them local avoids pulling the full core runtime into
 * frequently used renderer chunks.
 */

const RANDOM_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const CHOICE_COLOR_RGB_TUPLES = {
  blueBright: [0, 123, 255],
  blueDark1: [0, 63, 135],
  blueLight1: [153, 204, 255],
  blueLight2: [204, 229, 255],
  blue: [0, 102, 204],
  cyanBright: [0, 188, 212],
  cyanDark1: [0, 96, 100],
  cyanLight1: [153, 228, 236],
  cyanLight2: [204, 244, 248],
  cyan: [0, 151, 167],
  grayBright: [160, 160, 160],
  grayDark1: [80, 80, 80],
  grayLight1: [220, 220, 220],
  grayLight2: [245, 245, 245],
  gray: [128, 128, 128],
  greenBright: [40, 167, 69],
  greenDark1: [20, 83, 35],
  greenLight1: [144, 238, 144],
  greenLight2: [204, 255, 204],
  green: [30, 130, 76],
  orangeBright: [255, 159, 0],
  orangeDark1: [204, 85, 0],
  orangeLight1: [255, 204, 153],
  orangeLight2: [255, 229, 204],
  orange: [250, 128, 0],
  pinkBright: [255, 64, 123],
  pinkDark1: [194, 24, 91],
  pinkLight1: [255, 182, 193],
  pinkLight2: [255, 224, 230],
  pink: [255, 20, 147],
  purpleBright: [155, 89, 182],
  purpleDark1: [102, 51, 153],
  purpleLight1: [204, 153, 255],
  purpleLight2: [229, 204, 255],
  purple: [128, 0, 128],
  redBright: [241, 86, 70],
  redDark1: [163, 10, 10],
  redLight1: [255, 163, 163],
  redLight2: [255, 214, 214],
  red: [217, 10, 25],
  tealBright: [0, 150, 136],
  tealDark1: [0, 75, 68],
  tealLight1: [128, 203, 196],
  tealLight2: [178, 235, 242],
  teal: [0, 121, 107],
  yellowBright: [255, 212, 59],
  yellowDark1: [250, 176, 5],
  yellowLight1: [255, 236, 153],
  yellowLight2: [255, 243, 191],
  yellow: [252, 196, 25],
} as const satisfies Record<string, readonly [number, number, number]>;

type RgbTuple = readonly [number, number, number];

const clampChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const tupleToHex = ([r, g, b]: RgbTuple): string =>
  `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;

const parseHexColor = (value: string): RgbTuple | null => {
  const normalized = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    return [
      Number.parseInt(`${normalized[1]}${normalized[1]}`, 16),
      Number.parseInt(`${normalized[2]}${normalized[2]}`, 16),
      Number.parseInt(`${normalized[3]}${normalized[3]}`, 16),
    ];
  }

  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(1, 3), 16),
      Number.parseInt(normalized.slice(3, 5), 16),
      Number.parseInt(normalized.slice(5, 7), 16),
    ];
  }

  return null;
};

const parseRgbColor = (value: string): RgbTuple | null => {
  const match = value.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;

  const [r, g, b] = match[1]
    .split(',')
    .slice(0, 3)
    .map((segment) => clampChannel(Number.parseFloat(segment.trim())));

  if ([r, g, b].some((channel) => Number.isNaN(channel))) {
    return null;
  }

  return [r, g, b];
};

const parseColorToRgb = (value: string | null | undefined): RgbTuple | null => {
  if (!value) return null;
  return CHOICE_COLOR_RGB_TUPLES[value as keyof typeof CHOICE_COLOR_RGB_TUPLES]
    ?? parseHexColor(value)
    ?? parseRgbColor(value);
};

export const getHexForColor = (value: string | null | undefined): string | null => {
  const rgb = parseColorToRgb(value);
  return rgb ? tupleToHex(rgb) : null;
};

export const shouldUseLightTextOnColor = (value: string | null | undefined): boolean => {
  if (!value) return false;
  if (value.endsWith('Light1') || value.endsWith('Light2')) {
    return false;
  }

  const rgb = parseColorToRgb(value);
  if (!rgb) return false;

  const [r, g, b] = rgb;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.6;
};

export const contractColorForTheme = (color: string, theme: string | undefined): string => {
  const rgb = parseColorToRgb(color);
  if (!rgb) return color;

  const mixTarget = theme === 'light' ? 0 : 255;
  const mixRatio = theme === 'light' ? 0.45 : 0.35;
  const adjusted: RgbTuple = [
    rgb[0] + (mixTarget - rgb[0]) * mixRatio,
    rgb[1] + (mixTarget - rgb[1]) * mixRatio,
    rgb[2] + (mixTarget - rgb[2]) * mixRatio,
  ];

  return tupleToHex(adjusted);
};

export const getRandomString = (length: number): string => {
  if (length <= 0) return '';

  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const values = new Uint32Array(length);
    cryptoApi.getRandomValues(values);
    return Array.from(values, (value) => RANDOM_ALPHABET[value % RANDOM_ALPHABET.length]).join('');
  }

  return Array.from({ length }, () => (
    RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)]
  )).join('');
};
