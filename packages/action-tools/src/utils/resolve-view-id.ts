/**
 * 统一的 viewId 解析工具
 *
 * 约定优先级：viewId > crawlTabId
 * crawlTabId 是历史遗留别名，最终都映射到 viewId。
 */

export interface ViewIdResolvable {
  viewId?: string
  crawlTabId?: string
}

/**
 * 从输入参数中解析 viewId。
 *
 * 优先级：viewId > crawlTabId
 * 返回 undefined 表示两个字段均为空。
 */
export function resolveViewId(input: ViewIdResolvable): string | undefined {
  return input.viewId || input.crawlTabId || undefined
}
