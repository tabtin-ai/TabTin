/**
 * 文本气泡工具栏的预设数据与内联 SVG 图标。
 * 从 TextBubbleMenu.tsx 抽离纯展示常量 / 无状态图标组件。
 */
import React from 'react'

// 统一使用 pt，避免和后端默认字号单位混用导致往返误差
export const FONT_SIZES = ['9pt', '10pt', '12pt', '14pt', '16pt', '18pt', '20pt', '24pt', '28pt', '32pt', '36pt', '40pt', '44pt', '48pt', '54pt', '60pt', '72pt', '96pt']

export const LINE_HEIGHTS = [
  { label: '1.0', value: '1' },
  { label: '1.15', value: '1.15' },
  { label: '1.5', value: '1.5' },
  { label: '1.75', value: '1.75' },
  { label: '2.0', value: '2' },
  { label: '2.5', value: '2.5' },
  { label: '3.0', value: '3' },
]

export const LETTER_SPACINGS = [
  { label: 'letterSpacing.default', value: '' },
  { label: 'letterSpacing.tight', value: '-1px' },
  { label: '0', value: '0px' },
  { label: '0.5', value: '0.5px' },
  { label: '1', value: '1px' },
  { label: '2', value: '2px' },
  { label: '3', value: '3px' },
  { label: '5', value: '5px' },
  { label: '8', value: '8px' },
]

export const TEXT_COLORS = [
  { name: 'color.default', color: '' },
  { name: 'color.red', color: '#E03131' },
  { name: 'color.orange', color: '#E8590C' },
  { name: 'color.yellow', color: '#F08C00' },
  { name: 'color.green', color: '#2B8A3E' },
  { name: 'color.blue', color: '#1971C2' },
  { name: 'color.purple', color: '#6741D9' },
  { name: 'color.pink', color: '#C2255C' },
  { name: 'color.gray', color: '#868E96' },
  { name: 'color.black', color: '#000000' },
  { name: 'color.white', color: '#FFFFFF' },
]

export const HIGHLIGHT_COLORS = [
  { name: 'color.none', color: '' },
  { name: 'color.red', color: '#FFE3E3' },
  { name: 'color.orange', color: '#FFE8CC' },
  { name: 'color.yellow', color: '#FFF3BF' },
  { name: 'color.green', color: '#D3F9D8' },
  { name: 'color.blue', color: '#D0EBFF' },
  { name: 'color.purple', color: '#E5DBFF' },
  { name: 'color.pink', color: '#FFDEEB' },
  { name: 'color.gray', color: '#F1F3F5' },
]

/**
 * OOXML schemeClr 主题色定义，按索引对应 SlideTheme 中的字段。
 * themeColorKey 值需与 pptx.ts 中 _themeTextColorKeyMap 可识别的 key 一致。
 */
export const THEME_COLOR_DEFS: { key: string; label: string }[] = [
  { key: 'dk1', label: 'color.dark1' },
  { key: 'lt1', label: 'color.light1' },
  { key: 'accent1', label: 'color.accent1' },
  { key: 'accent2', label: 'color.accent2' },
  { key: 'accent3', label: 'color.accent3' },
  { key: 'accent4', label: 'color.accent4' },
  { key: 'accent5', label: 'color.accent5' },
  { key: 'accent6', label: 'color.accent6' },
]

// ═══════════════════════════════════════════════
// 内联 SVG 图标
// ═══════════════════════════════════════════════

const I = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const BoldIcon = () => <svg {...I}><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
export const ItalicIcon = () => <svg {...I}><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
export const UnderlineIcon = () => <svg {...I}><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
export const StrikeIcon = () => <svg {...I}><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/></svg>
export const LinkIcon = () => <svg {...I}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
export const AlignLeftIcon = () => <svg {...I}><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>
export const AlignCenterIcon = () => <svg {...I}><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>
export const AlignRightIcon = () => <svg {...I}><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>
export const AlignJustifyIcon = () => <svg {...I}><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
export const LineHeightIcon = () => <svg {...I}><path d="M3 8l3-3 3 3"/><path d="M3 16l3 3 3-3"/><line x1="6" y1="5" x2="6" y2="19"/><line x1="13" y1="6" x2="21" y2="6"/><line x1="13" y1="12" x2="21" y2="12"/><line x1="13" y1="18" x2="21" y2="18"/></svg>
export const ChevronDownIcon = ({ size = 10 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
export const BulletListIcon = () => <svg {...I}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></svg>
export const OrderedListIcon = () => <svg {...I}><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="4" y="7.5" fontSize="7" fill="currentColor" stroke="none" fontFamily="system-ui">1</text><text x="4" y="13.5" fontSize="7" fill="currentColor" stroke="none" fontFamily="system-ui">2</text><text x="4" y="19.5" fontSize="7" fill="currentColor" stroke="none" fontFamily="system-ui">3</text></svg>
export const IndentIcon = () => <svg {...I}><line x1="12" y1="6" x2="21" y2="6"/><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/><polyline points="3 8 7 12 3 16"/></svg>
export const OutdentIcon = () => <svg {...I}><line x1="12" y1="6" x2="21" y2="6"/><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/><polyline points="7 8 3 12 7 16"/></svg>
export const SuperscriptIcon = () => <svg {...I}><text x="3" y="16" fontSize="14" fill="currentColor" stroke="none" fontFamily="system-ui" fontWeight="bold">x</text><text x="14" y="10" fontSize="9" fill="currentColor" stroke="none" fontFamily="system-ui" fontWeight="bold">2</text></svg>
export const SubscriptIcon = () => <svg {...I}><text x="3" y="14" fontSize="14" fill="currentColor" stroke="none" fontFamily="system-ui" fontWeight="bold">x</text><text x="14" y="20" fontSize="9" fill="currentColor" stroke="none" fontFamily="system-ui" fontWeight="bold">2</text></svg>
export const LetterSpacingIcon = () => <svg {...I}><text x="4" y="14" fontSize="10" fill="currentColor" stroke="none" fontFamily="system-ui" fontWeight="bold">A</text><text x="14" y="14" fontSize="10" fill="currentColor" stroke="none" fontFamily="system-ui" fontWeight="bold">V</text><path d="M3 18h4" strokeWidth={1.5}/><path d="M17 18h4" strokeWidth={1.5}/><line x1="10" y1="17" x2="10" y2="19" strokeWidth={1.5}/></svg>
