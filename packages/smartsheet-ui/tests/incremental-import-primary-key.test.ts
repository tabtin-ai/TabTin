import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { isIncrementalPrimaryKeyMissing } from '../src/components/import/preview-mapping'

test('isIncrementalPrimaryKeyMissing blocks when incremental is on without key', () => {
  assert.equal(isIncrementalPrimaryKeyMissing(true, ''), true)
  assert.equal(isIncrementalPrimaryKeyMissing(true, '   '), true)
})

test('isIncrementalPrimaryKeyMissing allows full import or incremental with key', () => {
  assert.equal(isIncrementalPrimaryKeyMissing(false, ''), false)
  assert.equal(isIncrementalPrimaryKeyMissing(true, 'field-id'), false)
  assert.equal(isIncrementalPrimaryKeyMissing(false, 'field-id'), false)
})

test('PreviewMapping syncs incremental on check even without primary key', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/import/preview-mapping.tsx'),
    'utf8',
  )

  assert.match(
    source,
    /勾选后立即同步父层[\s\S]*onIncrementalChange\(true, primaryKeyField \|\| ''\)/,
  )
  assert.doesNotMatch(
    source,
    /else if \(primaryKeyField\) \{\s*onIncrementalChange\(true, primaryKeyField\)/,
  )
})

test('ImportDialog validates primary key on start and focuses select', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/import/import-dialog.tsx'),
    'utf8',
  )

  assert.match(source, /isIncrementalPrimaryKeyMissing\(updateExisting, primaryKeyField\)/)
  assert.match(source, /previewMappingRef\.current\?\.focusPrimaryKey\(\)/)
  assert.match(source, /setPrimaryKeyError\(t\('previewMapping\.options\.primaryKey\.required'\)\)/)
  // 预览步不再靠禁用按钮挡缺主键
  assert.match(source, /setCanGoNext\(true\);/)
  assert.doesNotMatch(
    source,
    /if \(updateExisting\) \{\s*setCanGoNext\(\!\!primaryKeyField\);/,
  )
})

test('required i18n copy states primary key is mandatory for incremental import', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/i18n.ts'),
    'utf8',
  )

  assert.match(
    source,
    /'previewMapping\.options\.primaryKey\.required': '增量导入时主键为必选项'/,
  )
  assert.match(
    source,
    /'previewMapping\.options\.primaryKey\.required': 'Primary key is required for incremental import'/,
  )
})
