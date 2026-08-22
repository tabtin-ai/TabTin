/**
 * canvasUi — 主画布 / 模块页 typography token
 *
 * renderer zoom 0.9 下侧栏/画布可读密度：只抬 typography，padding/gap 不变。
 * 与 sidebarUi（侧栏）并列；勿把侧栏 token 套进主画布。
 *
 * 字号阶梯（CSS px，×0.9 为视觉尺寸）：
 *   SECONDARY  14px — 页副标题、说明段落、QuickStart 描述
 *   META       13px — 面包屑、成员数、卡片 meta
 *   EYEBROW    13px medium — 区块眉语（「概况」「动态流」）
 *   MICRO      12px — 时间戳、badge、表单 label（保持 design-system caption）
 */

/** 副标题、说明段落（原 text-caption 12px → 14px body） */
export const CANVAS_TEXT_SECONDARY = 'text-body leading-[22px] text-muted-foreground/70 antialiased'

/** 面包屑、成员数、卡片 meta */
// eslint-disable-next-line tabtin/no-design-system-violations -- canvas meta readable density @ zoom 0.9
export const CANVAS_TEXT_META_BASE = 'text-[13px] leading-[18px] antialiased'

export const CANVAS_TEXT_META = `${CANVAS_TEXT_META_BASE} text-muted-foreground/70`

/** 区块眉语 */
// eslint-disable-next-line tabtin/no-design-system-violations -- canvas eyebrow readable density @ zoom 0.9
export const CANVAS_TEXT_EYEBROW = 'text-[13px] leading-[18px] font-medium text-muted-foreground/70 antialiased'

/** 时间戳、badge、tabular 计数 — 保持 design-system caption */
export const CANVAS_TEXT_MICRO = 'text-caption'

/** 详情侧栏 uppercase 分组标题（操作 / 属性） */
// eslint-disable-next-line tabtin/no-design-system-violations -- canvas section readable density @ zoom 0.9
export const CANVAS_TEXT_SECTION_LABEL =
  'text-[13px] leading-[18px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 antialiased'

/** ContextTabs 标签 — 13px，h-7 不变；颜色由 ACTIVE/INACTIVE class 承担 */
// eslint-disable-next-line tabtin/no-design-system-violations -- canvas tabs readable density @ zoom 0.9
export const CANVAS_TAB_TEXT = 'text-[13px] leading-[18px] antialiased'
