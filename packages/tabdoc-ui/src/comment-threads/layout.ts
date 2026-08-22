/** 宽度 ≥ 此值时使用固定右栏；否则改为抽屉。 */
export const COMMENT_RAIL_BREAKPOINT_PX = 1180
export const COMMENT_RAIL_WIDTH_PX = 360

export type CommentRailLayoutMode = 'rail' | 'drawer'

export function resolveCommentRailLayout(viewportWidth: number): CommentRailLayoutMode {
  return viewportWidth >= COMMENT_RAIL_BREAKPOINT_PX ? 'rail' : 'drawer'
}

/**
 * 右栏（rail）打开时应收起大纲；抽屉模式不强制。
 * 宿主把返回值接到大纲折叠回调即可。
 */
export function shouldCollapseOutlineForComments(input: {
  open: boolean
  layout: CommentRailLayoutMode
}): boolean {
  return input.open && input.layout === 'rail'
}
