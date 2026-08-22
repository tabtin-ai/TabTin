/**
 * 检测流式 Markdown 内容中未闭合的代码围栏，必要时补 ```。
 *
 * 从尾部向前扫描最多 50 行，统计 ``` 开头的围栏标记数量。
 * 若为奇数则说明存在未闭合围栏，追加闭合标记。
 */
export function ensureClosedFences(content: string): string {
  let fences = 0
  let pos = content.length
  let checks = 0
  while (pos > 0 && checks < 50) {
    const lineStart = content.lastIndexOf('\n', pos - 1)
    const line = content.substring(lineStart + 1, pos).trimStart()
    if (/^`{3}(?!`)/.test(line)) fences++
    pos = lineStart
    if (lineStart <= 0) break
    checks++
  }
  return fences % 2 === 1 ? content + '\n```' : content
}
