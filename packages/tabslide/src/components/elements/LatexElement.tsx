import React from 'react'
import type { PPTLatexElement } from '../../types/slides'
import * as t from '../../theme'
import { normalizeLatexSvgForDisplay } from '../../utils/latex-shared'

interface LatexElementProps {
  element: PPTLatexElement
}

/**
 * LaTeX 公式元素
 *
 * PPTist 的优秀设计：存储渲染后的 SVG path + viewBox，
 * 而不是 HTML。这样公式在任意缩放下都保持矢量清晰。
 *
 * 渲染策略：
 * - 有 path + viewBox：直接渲染 SVG（矢量，无限清晰）
 * - 无 path：显示 LaTeX 源码作为占位
 */
const LatexElement: React.FC<LatexElementProps> = ({ element }) => {
  if (element.svg) {
    return (
      <div
        style={{ width: '100%', height: '100%', color: element.color || t.textPrimary }}
        dangerouslySetInnerHTML={{ __html: normalizeLatexSvgForDisplay(element.svg) }}
      />
    )
  }

  if (element.path && element.viewBox) {
    return (
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${element.viewBox?.[0] ?? element.width} ${element.viewBox?.[1] ?? element.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <path
          d={element.path}
          fill={element.color || t.textPrimary}
          stroke={element.color || t.textPrimary}
          strokeWidth={element.strokeWidth || 0}
        />
      </svg>
    )
  }

  if (element.rasterSrc) {
    return (
      <img
        src={element.rasterSrc}
        alt={element.latex || 'LaTeX'}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        draggable={false}
      />
    )
  }

  // Fallback: 显示 LaTeX 源码
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: t.bgMuted,
        border: `1px dashed ${t.borderLight}`,
        borderRadius: 4,
        fontFamily: '"Times New Roman", serif',
        fontSize: 14,
        color: t.textSecondary,
        padding: 8,
        wordBreak: 'break-all',
      }}
    >
      {element.latex}
    </div>
  )
}

export default React.memo(LatexElement)
