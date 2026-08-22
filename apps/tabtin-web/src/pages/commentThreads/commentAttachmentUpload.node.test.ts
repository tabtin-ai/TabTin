import assert from 'node:assert/strict'
import test from 'node:test'
import { validateShareCommentImage } from './validateShareCommentImage.ts'

function fakeFile(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(Math.min(size, 16))], { type })
  const file = new File([blob], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

test('拒绝非图片', () => {
  const result = validateShareCommentImage(fakeFile('a.txt', 'text/plain', 10))
  assert.equal(result.valid, false)
})

test('接受常见图片类型且体积合法', () => {
  const result = validateShareCommentImage(fakeFile('a.png', 'image/png', 1024))
  assert.equal(result.valid, true)
})

test('拒绝超过 20MB', () => {
  const result = validateShareCommentImage(fakeFile('big.png', 'image/png', 21 * 1024 * 1024))
  assert.equal(result.valid, false)
})
