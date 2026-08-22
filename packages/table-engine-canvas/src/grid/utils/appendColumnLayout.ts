import { GRID_DEFAULT } from '../configs'

export type AppendColumnLayoutInput = {
  totalWidth: number
  scrollLeft: number
  /** 冻结区右缘；无冻结时等于 columnInitSize */
  freezeRegionWidth: number
  /** 行号区右缘 = 首个数据列左缘 */
  columnInitSize: number
  /** 数据列数量；0 表示空表，允许在 columnInitSize 处画添加列 */
  columnCount: number
}

/**
 * AppendColumn（添加字段灰条）的屏幕 X。
 *
 * 横向滚动后 naive `totalWidth - scrollLeft` 会落到行号区右侧，
 * 盖住首列（有冻结或 freeze_columns=0 时都会发生）。
 * 有数据列时：不得画在 columnInitSize 及更左；并不得钻进冻结区。
 * 无数据列时：允许贴在 columnInitSize，方便空表添加首字段。
 */
export function getAppendColumnScreenX(input: AppendColumnLayoutInput): number | null {
  const x = input.totalWidth - input.scrollLeft
  if (input.columnCount > 0 && x <= input.columnInitSize) return null
  if (x < input.freezeRegionWidth) return null
  return x
}

/** @deprecated 兼容旧三参签名；请改用对象入参版本 */
export function getAppendColumnScreenXLegacy(
  totalWidth: number,
  scrollLeft: number,
  freezeRegionWidth: number,
): number | null {
  return getAppendColumnScreenX({
    totalWidth,
    scrollLeft,
    freezeRegionWidth,
    columnInitSize: freezeRegionWidth,
    // 旧逻辑无法区分空表；保守按「有列」处理以免再盖住内容
    columnCount: 1,
  })
}

/** 指针是否落在 AppendColumn 可点区域内。 */
export function isAppendColumnPointerHit(input: {
  screenX: number
  scrollLeft: number
  totalWidth: number
  freezeRegionWidth: number
  columnInitSize: number
  columnCount: number
  appendWidth?: number
}): boolean {
  const appendWidth = input.appendWidth ?? GRID_DEFAULT.columnAppendBtnWidth
  const appendX = getAppendColumnScreenX({
    totalWidth: input.totalWidth,
    scrollLeft: input.scrollLeft,
    freezeRegionWidth: input.freezeRegionWidth,
    columnInitSize: input.columnInitSize,
    columnCount: input.columnCount,
  })
  if (appendX == null) return false
  if (input.screenX < appendX || input.screenX >= appendX + appendWidth) return false
  return true
}
