/**
 * decodeImportText 编码探测测试（GitHub  Bug1）。
 *
 * 直接导入真实实现（import-encoding.ts 无 barrel 依赖，可安全在 node:test 加载），
 * 验证 UTF-8 优先、GBK 回退、BOM 剥离。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeImportText } from '../src/data/services/import-encoding'

function toBuffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

test('decodes UTF-8 content', () => {
  const utf8 = new TextEncoder().encode('姓名,年龄\n张三,25')
  assert.equal(decodeImportText(utf8.buffer), '姓名,年龄\n张三,25')
})

test('strips UTF-8 BOM', () => {
  const body = new TextEncoder().encode('标题')
  const withBom = new Uint8Array(body.length + 3)
  withBom.set([0xef, 0xbb, 0xbf], 0)
  withBom.set(body, 3)
  assert.equal(decodeImportText(withBom.buffer), '标题')
})

test('falls back to GBK for non-UTF-8 bytes', () => {
  // "标题" 的 GBK 编码：B1 EA CC E2
  const gbk = toBuffer([0xb1, 0xea, 0xcc, 0xe2])
  assert.equal(decodeImportText(gbk), '标题')
})

test('decodes ASCII identically under either path', () => {
  const ascii = toBuffer([0x61, 0x2c, 0x62]) // "a,b"
  assert.equal(decodeImportText(ascii), 'a,b')
})
