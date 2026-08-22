import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VERSION_TOKEN_BASE_DEFAULT,
  buildVersionEtag,
  coerceMonotonicVersionToken,
  encodeMonotonicVersionToken,
  parseVersionTokenFromEtag,
  patchVersionInEtag,
} from '../src'

test('version-token: coerceMonotonicVersionToken 仅接受新 token', () => {
  assert.equal(coerceMonotonicVersionToken(VERSION_TOKEN_BASE_DEFAULT + 12), VERSION_TOKEN_BASE_DEFAULT + 12)
  assert.equal(coerceMonotonicVersionToken('1700000000000'), null) // 旧时间戳 token
  assert.equal(coerceMonotonicVersionToken(null), null)
})

test('version-token: encodeMonotonicVersionToken 输出 base+version', () => {
  assert.equal(encodeMonotonicVersionToken(1), VERSION_TOKEN_BASE_DEFAULT + 1)
  assert.equal(encodeMonotonicVersionToken('8'), VERSION_TOKEN_BASE_DEFAULT + 8)
  assert.equal(encodeMonotonicVersionToken(0), null)
})

test('version-token: parseVersionTokenFromEtag 支持 view 签名 ETag', () => {
  const token = VERSION_TOKEN_BASE_DEFAULT + 256
  assert.equal(parseVersionTokenFromEtag(`"${token}:abc123def4567890"`), token)
  assert.equal(parseVersionTokenFromEtag(`W/"${token}:sig"`), token)
  assert.equal(parseVersionTokenFromEtag('"1700000000000"'), null)
})

test('version-token: patchVersionInEtag 保留签名后缀', () => {
  const nextToken = VERSION_TOKEN_BASE_DEFAULT + 999
  assert.equal(
    patchVersionInEtag('"4000000000123:deadbeef"', nextToken),
    `"${nextToken}:deadbeef"`,
  )
  assert.equal(
    patchVersionInEtag('W/"4000000000123:sig"', nextToken),
    `W/"${nextToken}:sig"`,
  )
  assert.equal(patchVersionInEtag(null, nextToken), buildVersionEtag(nextToken))
})
