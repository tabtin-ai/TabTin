/**
 * 版本预览的视图选择（TD-5 D-1 门控），抽成纯函数便于单测。
 *
 * 规则（2026-05-29 产品决策：版本面板默认展示 diff，不分编辑者）：
 * - 只要技术上能 diff（canDiff=true，即有 previous 且与当前不同）→ **默认 diff**
 * - 首版无 previous（canDiff=false）→ 降级全文，即便 override=true 也不 diff
 * - 用户手动切换（override）优先：override=false 切回全文、override=true 切 diff
 * - editorType 暂保留在签名（将来若要按编辑者差异化再用），当前不参与默认判定
 */
export function resolveVersionPreviewMode(opts: {
  editorType?: string
  canDiff: boolean
  override: boolean | null
}): 'diff' | 'full' {
  const { canDiff, override } = opts
  const showDiff = canDiff && (override ?? true)
  return showDiff ? 'diff' : 'full'
}
