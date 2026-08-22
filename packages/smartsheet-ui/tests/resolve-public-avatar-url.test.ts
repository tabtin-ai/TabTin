import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePublicAvatarUrl } from '../src/share-dialog/resolvePublicAvatarUrl'

test('keeps absolute urls', () => {
  assert.equal(
    resolvePublicAvatarUrl('https://assets.example.com/a.png'),
    'https://assets.example.com/a.png',
  )
})

test('maps user-avatars object keys to assets CDN', () => {
  assert.equal(
    resolvePublicAvatarUrl('user-avatars/042a.png'),
    'https://assets.example.com/user-avatars/042a.png',
  )
})

test('prefers origin hint when provided', () => {
  assert.equal(
    resolvePublicAvatarUrl(
      'user-avatars/042a.png',
      'https://cdn.example.com/user-avatars/other.png',
    ),
    'https://cdn.example.com/user-avatars/042a.png',
  )
})

test('returns null for empty', () => {
  assert.equal(resolvePublicAvatarUrl(null), null)
  assert.equal(resolvePublicAvatarUrl(''), null)
})

test('returns null for unknown relative paths without origin hint', () => {
  assert.equal(resolvePublicAvatarUrl('not-a-valid-avatar-path.png'), null)
  assert.equal(resolvePublicAvatarUrl('/weird/path.png'), null)
})
