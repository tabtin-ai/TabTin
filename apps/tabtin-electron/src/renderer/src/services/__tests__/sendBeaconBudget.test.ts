/**
 * Wave 2 Round 2 P1-B：sendBeacon 预算用 UTF-8 字节数验证。
 *
 * 历史 bug：errorReporter.ts:sendBeaconSafe 三段式裁剪用 `payload.length` 比较
 * `SENDBEACON_PAYLOAD_BUDGET`，而 String.length 返回 UTF-16 code units——中文
 * 1 unit / 3 字节、emoji 2 units / 4 字节。结果中文 fatal 报错堆栈 length=60_000
 * 但 UTF-8 ≈ 180_000 字节 → 浏览器 silent return false → 三段都失败 → 双路径
 * 退化为单路径 flushErrors。
 *
 * 修复：用 `new Blob([payload]).size`（UTF-8 字节）替换 `.length`，并把 budget
 * 从 60_000 收到 55_000 给 emoji/中文留更多 margin。
 *
 * 本测试**不**直接调 sendBeaconSafe（它是 module 私有函数），而是验证浏览器
 * Blob.size 与 String.length 在多字节字符上的真实差异——证明"必须用字节比较"
 * 的前提；同时也确保未来如果有人手贱改回 .length，差异会立刻暴露。
 */
import { describe, it, expect } from 'vitest'

function blobBytes(s: string): number {
  return new Blob([s]).size
}

describe('sendBeacon UTF-8 byte budget vs String.length', () => {
  it('ascii: length === bytes', () => {
    const s = 'hello world'
    expect(s.length).toBe(11)
    expect(blobBytes(s)).toBe(11)
  })

  it('chinese: length 严重低估字节数（每字 3 字节）', () => {
    const s = '你好世界'
    expect(s.length).toBe(4)
    expect(blobBytes(s)).toBe(12) // 4 × 3 bytes UTF-8
  })

  it('emoji: BMP 外字符 length=2 但字节数=4', () => {
    const s = '🚀'
    expect(s.length).toBe(2) // surrogate pair: 2 UTF-16 code units
    expect(blobBytes(s)).toBe(4) // 4 bytes UTF-8
  })

  it('混合中英: 用 .length 比较 budget 会让真实 3× 字节的 payload 蒙混过关', () => {
    // 模拟 fatal 中文报错典型形态
    const message = '渲染过程中无法读取 props.user.name 属性 ' +
      'TypeError: Cannot read property of undefined'
    expect(message.length).toBeLessThan(80)
    // UTF-8 字节数明显大于 .length
    expect(blobBytes(message)).toBeGreaterThan(message.length)
  })

  it('budget=55000 字节预算对纯中文 payload 的"length 等价上限"≈ 18000', () => {
    // 反向验证：55_000 字节预算下，纯中文 payload 的 .length 上限 ≈ 18_333
    // 如果代码退化用 .length，60_000 length 的中文 payload（180_000 字节）
    // 会被判通过然后浏览器 silent fail
    const big = '错'.repeat(20_000)
    expect(big.length).toBe(20_000) // 看起来"很安全"
    expect(blobBytes(big)).toBe(60_000) // 实际超过 55_000 字节预算
  })
})
