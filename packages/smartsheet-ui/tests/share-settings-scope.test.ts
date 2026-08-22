import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import path from 'node:path'

test('useShareSettings defaults doc/table scope to organization and sends public ack', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/share-dialog/hooks/useShareSettings.ts'),
    'utf8',
  )

  // 安全缺省：doc / table 缺省均为 organization
  assert.match(source, /return 'organization'/)
  assert.match(source, /acknowledge_public_exposure/)
  assert.match(source, /defaultGetType: null/)
  // table 扩到 data 也发 ack
  assert.match(source, /resourceType === 'table' && shareType === 'data'/)
  // 无 share_type 时按组织内解析
  assert.match(source, /if \(!shareType\) return 'organization'/)
})

test('PublicLinkSection requires ConfirmDialog before widening to public for doc and table', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/share-dialog/PublicLinkSection.tsx'),
    'utf8',
  )

  assert.match(source, /publicConfirmOpen/)
  assert.match(source, /acknowledgePublicExposure: true/)
  // 首次开启固定 organization（不再按 isDoc 分支）
  assert.match(source, /const nextScope: ShareScope = 'organization'/)
  assert.match(source, /publicConfirmTitle/)
  assert.match(source, /variant="destructive"/)
  // 收窄 toast 对 doc/table 均生效
  assert.match(source, /next === 'organization' && currentScope === 'public'/)
  assert.match(source, /scopeNarrowedToast/)
  // 扩 public 不再仅限 isDoc
  assert.match(source, /if \(next === 'public'\)/)
  assert.doesNotMatch(source, /isDoc && next === 'public'/)
})
