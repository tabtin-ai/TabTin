/**
 * StreamingMarkdownSplitter — 将流式 Markdown 拆分为"稳定区"和"尾部区"。
 *
 * 稳定区：已经完成的顶层 Markdown 块（段落、标题、代码块、列表组等），
 *         内容不再变化，可以冻住渲染结果不参与后续 React reconciliation。
 * 尾部区：最后一个未完成的块，每帧轻量渲染。
 *
 * 分割策略：从末尾向前查找最后一个"双换行"（`\n\n`），该位置之前为稳定区。
 * 对代码块做特殊处理：如果稳定区末尾有未闭合的代码围栏，把整个代码块
 * 移到尾部区（避免截断代码块导致渲染错误）。
 */

export interface SplitResult {
  stable: string
  tail: string
}

const CODE_FENCE_RE = /^(`{3,}|~{3,})/

export function splitStreamingMarkdown(content: string): SplitResult {
  if (content.length < 200) {
    return { stable: '', tail: content }
  }

  const lastDoubleNewline = content.lastIndexOf('\n\n')

  if (lastDoubleNewline < 100) {
    return { stable: '', tail: content }
  }

  let splitPos = lastDoubleNewline + 2
  let candidate = content.slice(0, splitPos)

  let openFences = 0
  const lines = candidate.split('\n')
  for (const line of lines) {
    if (CODE_FENCE_RE.test(line.trimStart())) {
      openFences++
    }
  }

  if (openFences % 2 !== 0) {
    const fencePositions: number[] = []
    let pos = 0
    for (const line of lines) {
      if (CODE_FENCE_RE.test(line.trimStart())) {
        fencePositions.push(pos)
      }
      pos += line.length + 1
    }
    const lastOpenFence = fencePositions[fencePositions.length - 1]
    if (lastOpenFence > 0) {
      splitPos = lastOpenFence
      candidate = content.slice(0, splitPos)
    } else {
      return { stable: '', tail: content }
    }
  }

  return {
    stable: candidate,
    tail: content.slice(splitPos),
  }
}
