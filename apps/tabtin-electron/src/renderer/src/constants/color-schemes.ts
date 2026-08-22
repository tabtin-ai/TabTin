/**
 * TabTin 配色方案
 *
 * 7 种品牌色供用户选择
 */
import i18n from '@/i18n'

export type ColorSchemeId = 'blue' | 'teal' | 'orange' | 'rose' | 'slate' | 'violet' | 'sky'

export interface ColorScheme {
  id: ColorSchemeId
  label: string
  description: string
  accentLight: string
  accentDark: string
}

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: 'blue',
    label: i18n.t('theme:colorScheme.options.blue'),
    description: i18n.t('theme:colorScheme.descriptions.blue'),
    accentLight: '215 65% 52%',
    accentDark: '215 65% 62%',
  },
  {
    id: 'teal',
    label: i18n.t('theme:colorScheme.options.teal'),
    description: i18n.t('theme:colorScheme.descriptions.teal'),
    accentLight: '178 55% 42%',
    accentDark: '178 55% 55%',
  },
  {
    id: 'orange',
    label: i18n.t('theme:colorScheme.options.orange'),
    description: i18n.t('theme:colorScheme.descriptions.orange'),
    accentLight: '28 75% 52%',
    accentDark: '28 75% 60%',
  },
  {
    id: 'rose',
    label: i18n.t('theme:colorScheme.options.rose'),
    description: i18n.t('theme:colorScheme.descriptions.rose'),
    accentLight: '350 55% 52%',
    accentDark: '350 55% 62%',
  },
  {
    id: 'slate',
    label: i18n.t('theme:colorScheme.options.slate'),
    description: i18n.t('theme:colorScheme.descriptions.slate'),
    accentLight: '220 10% 42%',
    accentDark: '220 10% 60%',
  },
  {
    id: 'violet',
    label: i18n.t('theme:colorScheme.options.violet'),
    description: i18n.t('theme:colorScheme.descriptions.violet'),
    accentLight: '270 16% 38%',
    accentDark: '270 16% 55%',
  },
  {
    id: 'sky',
    label: i18n.t('theme:colorScheme.options.sky'),
    description: i18n.t('theme:colorScheme.descriptions.sky'),
    accentLight: '194 76% 50%',
    accentDark: '194 70% 58%',
  },
]

export const DEFAULT_COLOR_SCHEME: ColorSchemeId = 'blue'

export const getColorSchemeById = (id: ColorSchemeId) =>
  COLOR_SCHEMES.find((scheme) => scheme.id === id) ?? COLOR_SCHEMES[0]
