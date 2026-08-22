/**
 * 单格复制不带表头，避免粘贴出「列名\\n单元格值」
 *（URL 列常「链接\\nhttps://…」）。
 * 多格 / 多列仍尊重 copyHeaders。
 */
export function shouldIncludeClipboardHeaders(
  copyHeaders: boolean | undefined,
  selection: { minRow: number; maxRow: number; minCol: number; maxCol: number },
): boolean {
  if (!copyHeaders) return false
  const { minRow, maxRow, minCol, maxCol } = selection
  return !(minRow === maxRow && minCol === maxCol)
}
