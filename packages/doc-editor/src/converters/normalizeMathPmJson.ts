/**
 * 公式节点契约归一
 *
 * Canonical：
 * - 行内：`mathematics`（attrs.latex, display 通常 false）
 * - 块级：`mathematicsBlock`（attrs.latex）
 *
 * 历史兼容：
 * - Novel Slash 曾写入 `math` → `mathematics`
 * - 旧 markdown 转换曾把 $$...$$ 写成顶层 `mathematics{display:true}` → `mathematicsBlock`
 */

export type MathPmJsonNode = {
  type?: string
  attrs?: Record<string, unknown> | null
  content?: MathPmJsonNode[]
  [key: string]: unknown
}

const INLINE_PARENT_TYPES = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'tableHeader',
])

function latexOf(node: MathPmJsonNode): string {
  const raw = node.attrs?.latex
  return raw == null ? '' : String(raw)
}

function normalizeNode(
  node: MathPmJsonNode,
  parentType: string | null,
): { node: MathPmJsonNode; changed: boolean } {
  let current = node
  let changed = false

  if (current.type === 'math') {
    current = {
      ...current,
      type: 'mathematics',
      attrs: {
        ...(current.attrs ?? {}),
        latex: latexOf(current),
        display: false,
      },
    }
    changed = true
  }

  const parentIsInline = parentType != null && INLINE_PARENT_TYPES.has(parentType)
  if (
    current.type === 'mathematics'
    && current.attrs?.display === true
    && !parentIsInline
  ) {
    current = {
      type: 'mathematicsBlock',
      attrs: { latex: latexOf(current) },
      ...(current.marks ? { marks: current.marks } : {}),
    }
    changed = true
  }

  if (!Array.isArray(current.content) || current.content.length === 0) {
    return { node: current, changed }
  }

  let contentChanged = false
  const nextContent = current.content.map((child) => {
    const result = normalizeNode(child, current.type ?? null)
    if (result.changed) contentChanged = true
    return result.node
  })

  if (!contentChanged) {
    return { node: current, changed }
  }

  return {
    node: { ...current, content: nextContent },
    changed: true,
  }
}

/**
 * 归一 PM JSON 中的公式节点。无变化时返回原引用。
 */
export function normalizeMathPmJson<T extends Record<string, unknown>>(
  pmJson: T,
): T {
  if (!pmJson || typeof pmJson !== 'object') return pmJson
  const result = normalizeNode(pmJson as MathPmJsonNode, null)
  return (result.changed ? result.node : pmJson) as T
}
