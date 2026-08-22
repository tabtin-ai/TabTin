/**
 * Skeleton HTML 智能折叠算法
 * 将大型 HTML 压缩为可读的折叠结构
 */

/**
 * 智能折叠 HTML
 * @param html 原始 HTML 字符串
 * @returns 折叠后的结构化数据
 */
export function intelligentCollapseHTML(html: string): {
  collapsed: string
  stats: {
    originalLines: number
    collapsedLines: number
    collapsedSections: number
  }
} {
  const lines = html.split('\n')
  const result: string[] = []
  let i = 0
  let collapsedSections = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 检查是否是可折叠的大容器开始
    const containerMatch = trimmed.match(/<(header|footer|nav|aside)([^>]*)>/)
    if (containerMatch) {
      const tag = containerMatch[1]

      // 查找对应的结束标签
      let depth = 1
      let endIndex = i + 1
      let containerLines = 1

      while (endIndex < lines.length && depth > 0) {
        const endLine = lines[endIndex].trim()
        if (endLine.includes(`<${tag}`)) depth++
        if (endLine.includes(`</${tag}>`)) depth--
        containerLines++
        endIndex++
      }

      // 如果容器超过 30 行，折叠它
      if (containerLines > 30) {
        result.push(`${line}`, `  ... (折叠 ${containerLines} 行)  [📂 展开${tag}]`, `</${tag}>`)
        collapsedSections++
        i = endIndex
        continue
      }
    }

    // 检查是否是重复的列表项
    const articleMatch = trimmed.match(/<article([^>]*)>/)
    if (articleMatch) {
      // 统计连续的 article 数量
      let articleCount = 0
      let tempIndex = i

      while (tempIndex < lines.length) {
        if (lines[tempIndex].trim().startsWith('<article')) {
          articleCount++
          // 跳到这个 article 的结束
          let depth = 1
          tempIndex++
          while (tempIndex < lines.length && depth > 0) {
            if (lines[tempIndex].includes('<article')) depth++
            if (lines[tempIndex].includes('</article>')) depth--
            tempIndex++
          }
        } else {
          break
        }
      }

      // 如果有超过 3 个连续的 article，折叠除了第一个之外的
      if (articleCount > 3) {
        // 保留第一个 article
        let depth = 1
        result.push(line)
        i++
        while (i < lines.length && depth > 0) {
          result.push(lines[i])
          if (lines[i].includes('<article')) depth++
          if (lines[i].includes('</article>')) depth--
          i++
        }

        // 折叠剩余的
        result.push(`... (省略 ${articleCount - 1} 个相似 article)  [📂 展开全部列表]`)
        collapsedSections++

        // 跳过这些 article
        i = tempIndex
        continue
      }
    }

    // 默认：保留原行
    result.push(line)
    i++
  }

  return {
    collapsed: result.join('\n'),
    stats: {
      originalLines: lines.length,
      collapsedLines: result.length,
      collapsedSections,
    },
  }
}

/**
 * 计算 HTML 大小（KB）
 */
export function calculateHTMLSize(html: string): number {
  return new Blob([html]).size / 1024
}

/**
 * 提取 HTML 中的文本摘要
 */
export function extractHTMLSummary(html: string): string {
  // 移除 HTML 标签
  const text = html.replace(/<[^>]+>/g, ' ')
  // 移除多余空白
  const cleaned = text.replace(/\s+/g, ' ').trim()
  // 截取前 200 字符
  return cleaned.substring(0, 200) + (cleaned.length > 200 ? '...' : '')
}
