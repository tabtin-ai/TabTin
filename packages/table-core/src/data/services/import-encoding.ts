/**
 * 导入文本编码探测。
 *
 * 独立于 import-export-api（不引 barrel / http / runtime），便于在 node:test
 * 里直接对真实实现做单测，而不是镜像一份逻辑。
 */

/**
 * 探测 CSV/JSON 文本编码：先按 UTF-8 严格解码（自动剥离 BOM），
 * 遇到非法字节序列回退 GBK，与后端 `utf-8-sig → gbk` 策略对齐。
 */
export function decodeImportText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      // 运行时若不支持 gbk 标签，退回非严格 UTF-8，至少不抛异常中断导入。
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}
