import { nanoid } from 'nanoid'

/** 生成元素 ID */
export const createElementId = () => `el_${nanoid(8)}`

/** 生成页面 ID */
export const createPageId = () => `page_${nanoid(8)}`

/** 生成项目 ID */
export const createPresentationId = () => `pres_${nanoid(10)}`

/**
 * 重新生成元素内部嵌套的 ID（如 table cell ID）。
 * 调用前请确保 element 已是 structuredClone 的副本。
 */
export function regenerateNestedIds(el: { type?: string }): void {
  if (el.type !== 'table') return
  const data = (el as Record<string, unknown>).data
  if (!Array.isArray(data)) return
  for (const row of data as Array<Array<{ id?: string }>>) {
    for (const cell of row) {
      if (cell && typeof cell.id === 'string') {
        cell.id = createElementId()
      }
    }
  }
}
