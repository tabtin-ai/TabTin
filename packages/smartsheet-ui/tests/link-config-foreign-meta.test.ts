import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import path from 'node:path'

const linkConfigPath = path.resolve(
  process.cwd(),
  'src/components/field-config/LinkConfigSection.tsx',
)
const formPath = path.resolve(process.cwd(), 'src/hooks/useFieldConfigForm.ts')

test('LinkConfigSection preloads foreign meta when a linked table is selected', () => {
  const source = fs.readFileSync(linkConfigPath, 'utf8')

  assert.match(source, /选中关联表后立刻预加载字段/)
  assert.doesNotMatch(
    source,
    /if \(showAdvanced && foreignTableId && foreignFields\.length === 0\)/,
  )
  assert.match(source, /metaError/)
  assert.match(source, /retryLoadForeignMeta/)
  assert.match(source, /noForeignFields/)
  assert.match(source, /!foreignTableId \?/)
  assert.match(source, /关联表高级设置/)
  assert.doesNotMatch(source, /fieldSettingPanel\.link\.filterByView/)
  assert.doesNotMatch(source, /fieldSettingPanel\.link\.customFilter/)
})

test('useFieldConfigForm always persists link lookupFieldId including empty reset', () => {
  const source = fs.readFileSync(formPath, 'utf8')

  assert.match(
    source,
    /options\.lookupFieldId = state\.linkLookupFieldId/,
  )
  assert.match(
    source,
    /options\.visibleFieldIds = state\.linkVisibleFieldIds/,
  )
  assert.match(source, /opts\.foreign_table_id/)
})
