/**
 * MermaidBlock 的渲染配置与产物清洗。
 *
 * 与组件分开，是为了让「真实 mermaid 编译 → 清洗」这条管道能脱离 React 直接被测。
 */

import DOMPurify from 'dompurify'

/**
 * Mermaid v11 默认把节点 label 放进 `<foreignObject>` 里的 HTML，而 DOMPurify 的
 * SVG 白名单不含这个标签，清洗时会连内容整段删掉，节点只剩没字的空壳形状。
 * `htmlLabels: false` 让 label 落成原生 `<text>`，与 show_widget 的
 * mermaid-compiler 是同一口径。顶层与 flowchart 都设，是为了覆盖 class、state
 * 等同样支持该选项的图类型。
 */
export function mermaidConfigFor(resolvedTheme: string) {
  return {
    startOnLoad: false,
    theme: resolvedTheme === 'dark' ? ('dark' as const) : ('default' as const),
    securityLevel: 'strict' as const,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  }
}

export function sanitizeMermaidSvg(rendered: string): string {
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { svg: true, svgFilters: true },
  })
}
