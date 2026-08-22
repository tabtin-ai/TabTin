/**
 * Choice / Tag 颜色工具集
 *
 * 从 ViewFilterRulesEditor 中提炼，提供：
 * - CHOICE_COLOR_HEX_MAP: 选项语义色名 → HEX 映射
 * - FALLBACK_TAG_COLORS: 无颜色时的回退色板
 * - resolveChoiceTagColors(): 解析选项的背景色和文字色
 * - stableHash(): 稳定哈希（用于确定回退颜色索引）
 */

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const CHOICE_COLOR_HEX_MAP: Record<string, string> = {
  blueLight2: '#CCE5FF',
  blueLight1: '#99CCFF',
  blueBright: '#007BFF',
  blue: '#0066CC',
  blueDark1: '#003F87',
  cyanLight2: '#CCF4F8',
  cyanLight1: '#99E4EC',
  cyanBright: '#00BCD4',
  cyan: '#0097A7',
  cyanDark1: '#006064',
  grayLight2: '#F5F5F5',
  grayLight1: '#DCDCDC',
  grayBright: '#A0A0A0',
  gray: '#808080',
  grayDark1: '#505050',
  greenLight2: '#CCFFCC',
  greenLight1: '#90EE90',
  greenBright: '#28A745',
  green: '#1E824C',
  greenDark1: '#145323',
  orangeLight2: '#FFE5CC',
  orangeLight1: '#FFCC99',
  orangeBright: '#FF9F00',
  orange: '#FA8000',
  orangeDark1: '#CC5500',
  pinkLight2: '#FFE0E6',
  pinkLight1: '#FFB6C1',
  pinkBright: '#FF407B',
  pink: '#FF1493',
  pinkDark1: '#C2185B',
  purpleLight2: '#E5CCFF',
  purpleLight1: '#CC99FF',
  purpleBright: '#9B59B6',
  purple: '#800080',
  purpleDark1: '#663399',
  redLight2: '#FFD6D6',
  redLight1: '#FFA3A3',
  redBright: '#F15646',
  red: '#D90A19',
  redDark1: '#A30A0A',
  tealLight2: '#B2EBF2',
  tealLight1: '#80CBC4',
  tealBright: '#009688',
  teal: '#00796B',
  tealDark1: '#004B44',
  yellowLight2: '#FFF3BF',
  yellowLight1: '#FFEC99',
  yellowBright: '#FFD43B',
  yellow: '#FCC419',
  yellowDark1: '#FAB005',
}

// ---------------------------------------------------------------------------
// 回退色板
// ---------------------------------------------------------------------------

export const FALLBACK_TAG_BG_COLORS: readonly string[] = [
  '#FEE2E2',
  '#FFEDD5',
  '#FEF3C7',
  '#ECFCCB',
  '#DCFCE7',
  '#CCFBF1',
  '#CFFAFE',
  '#DBEAFE',
  '#E0E7FF',
  '#EDE9FE',
  '#F3E8FF',
  '#FCE7F3',
] as const

export const FALLBACK_TAG_TEXT_COLORS: readonly string[] = [
  '#EF4444',
  '#F97316',
  '#F59E0B',
  '#84CC16',
  '#22C55E',
  '#14B8A6',
  '#06B6D4',
  '#3B82F6',
  '#6366F1',
  '#8B5CF6',
  '#A855F7',
  '#EC4899',
] as const

/** 单选/多选字段共用的固定预设色板。 */
export const SELECT_CHOICE_PRESET_COLORS: readonly string[] = [
  '#0066CC', '#007BFF', '#99CCFF',
  '#0097A7', '#00BCD4', '#99E4EC',
  '#1E824C', '#28A745', '#90EE90',
  '#FA8000', '#FF9F00', '#FFCC99',
  '#FF1493', '#FF407B', '#FFB6C1',
  '#800080', '#9B59B6', '#CC99FF',
  '#D90A19', '#F15646', '#FFA3A3',
  '#00796B', '#009688', '#80CBC4',
  '#FCC419', '#FFD43B', '#FFEC99',
  '#808080', '#A0A0A0', '#DCDCDC',
] as const

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 稳定哈希函数（djb2 变体） */
export function stableHash(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/** 标准化 HEX 颜色值 */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim()
  const shortHexMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  if (shortHexMatch) {
    const [, rgb] = shortHexMatch
    return `#${rgb[0]}${rgb[0]}${rgb[1]}${rgb[1]}${rgb[2]}${rgb[2]}`.toUpperCase()
  }
  const fullHexMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed)
  if (fullHexMatch) {
    return `#${fullHexMatch[1].toUpperCase()}`
  }
  return null
}

/** 判断 HEX 颜色是否为浅色 */
export function isLightHexColor(hex: string): boolean {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return false
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000
  return brightness >= 155
}

export type ChoiceItem = string | Record<string, unknown>

export interface SelectChoiceOption extends Record<string, unknown> {
  value: string
  label: string
  color: string
}

export function getChoiceValue(choice: ChoiceItem): string {
  if (typeof choice === 'string') return choice
  return String(choice.value ?? choice.name ?? choice.label ?? choice.id ?? '')
}

export function getChoiceLabel(choice: ChoiceItem): string {
  if (typeof choice === 'string') return choice
  return String(choice.label ?? choice.name ?? choice.value ?? choice.id ?? '')
}

export function choicesToText(choices: ChoiceItem[]): string {
  return choices.map(getChoiceValue).join('\n')
}

/**
 * 把历史 string choice 和对象 choice 统一成可编辑结构。
 * 已保存的颜色保持原值；无颜色的旧数据和新选项才从固定色板补色。
 */
export function normalizeSelectChoices(choices: ChoiceItem[]): SelectChoiceOption[] {
  return choices.map((choice, index) => {
    const value = getChoiceValue(choice)
    const label = getChoiceLabel(choice) || value
    const rawColor = typeof choice === 'object' && typeof choice.color === 'string'
      ? choice.color.trim()
      : ''
    const fallbackSeed = value || label
    return {
      value,
      label,
      color: rawColor || SELECT_CHOICE_PRESET_COLORS[
        fallbackSeed
          ? stableHash(fallbackSeed) % SELECT_CHOICE_PRESET_COLORS.length
          : index % SELECT_CHOICE_PRESET_COLORS.length
      ],
    }
  })
}

export interface ChoiceColorOption {
  value: string
  label: string
  color?: string
}

/**
 * 解析 choice/tag 的背景色和文字色。
 *
 * 优先级：color 字段 → CHOICE_COLOR_HEX_MAP → HEX 直接值 → 回退色板
 */
export function resolveChoiceTagColors(
  option: ChoiceColorOption,
): { backgroundColor: string; color: string } {
  const rawColor = typeof option.color === 'string' ? option.color.trim() : ''
  const mappedHex = rawColor ? CHOICE_COLOR_HEX_MAP[rawColor] : null
  const resolvedHex = mappedHex ?? (rawColor ? normalizeHexColor(rawColor) : null)
  if (resolvedHex) {
    return {
      backgroundColor: resolvedHex,
      color: isLightHexColor(resolvedHex) ? '#000000' : '#FFFFFF',
    }
  }
  const seed = option.value || option.label
  const idx = stableHash(seed) % FALLBACK_TAG_BG_COLORS.length
  return {
    backgroundColor: FALLBACK_TAG_BG_COLORS[idx],
    color: FALLBACK_TAG_TEXT_COLORS[idx],
  }
}

/** 将饱和色与白色混合，得到飞书式浅色胶囊底。ratio 为白色占比（0–1）。 */
export function mixHexWithWhite(hex: string, whiteRatio = 0.82): string | null {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return null
  const clamped = Math.min(1, Math.max(0, whiteRatio))
  const mix = (channel: number) => Math.round(channel + (255 - channel) * clamped)
  const red = mix(Number.parseInt(normalized.slice(1, 3), 16))
  const green = mix(Number.parseInt(normalized.slice(3, 5), 16))
  const blue = mix(Number.parseInt(normalized.slice(5, 7), 16))
  return `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue
    .toString(16)
    .padStart(2, '0')}`.toUpperCase()
}

/** 判断是否为足够浅的 pastel。保留给其它颜色场景使用。 */
export function isPastelHexColor(hex: string): boolean {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return false
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const saturation = max === 0 ? 0 : (max - min) / max
  // 很浅，或偏浅且饱和度不高
  return brightness >= 200 || (brightness >= 180 && saturation <= 0.45)
}

/**
 * 表格单选/多选胶囊色：保存的选项色就是标签背景色，
 * 仅根据背景明暗派生黑/白文字色。
 */
export function resolveSelectChipColors(
  option: ChoiceColorOption,
): { backgroundColor: string; color: string } {
  const rawColor = typeof option.color === 'string' ? option.color.trim() : ''
  const mappedHex = rawColor ? CHOICE_COLOR_HEX_MAP[rawColor] : null
  if (mappedHex) {
    return {
      backgroundColor: mappedHex,
      color: isLightHexColor(mappedHex) ? '#000000' : '#FFFFFF',
    }
  }

  const hex = rawColor ? normalizeHexColor(rawColor) : null
  if (hex) {
    return {
      backgroundColor: hex,
      color: isLightHexColor(hex) ? '#000000' : '#FFFFFF',
    }
  }

  const seed = option.value || option.label
  const backgroundColor = SELECT_CHOICE_PRESET_COLORS[stableHash(seed) % SELECT_CHOICE_PRESET_COLORS.length]
  return {
    backgroundColor,
    color: isLightHexColor(backgroundColor) ? '#000000' : '#FFFFFF',
  }
}
