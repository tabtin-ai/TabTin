import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('table-core 主字段白名单与后端一致（不含 rating / long_text）', () => {
  const tableCoreField = fs.readFileSync(
    path.resolve(process.cwd(), '../table-core/src/data/types/field.ts'),
    'utf8',
  )
  const backendService = fs.readFileSync(
    path.resolve(
      process.cwd(),
      '../../apps/tabtin_django/apps/tabdata/services/table_service.py',
    ),
    'utf8',
  )

  assert.match(
    tableCoreField,
    /export const PRIMARY_FIELD_ALLOWED_TYPES = \[\s*'text',\s*'number',\s*'select',\s*'url',\s*'email',\s*'phone',\s*\]/,
  )
  assert.doesNotMatch(tableCoreField, /PRIMARY_FIELD_ALLOWED_TYPES[\s\S]*'rating'/)
  assert.doesNotMatch(tableCoreField, /PRIMARY_FIELD_ALLOWED_TYPES[\s\S]*'long_text'/)

  assert.match(
    backendService,
    /PRIMARY_FIELD_ALLOWED_TYPES = \{'text', 'number', 'select', 'url', 'email', 'phone'\}/,
  )
})

test('FieldTypeSelector / useFieldConfigForm 复用 table-core，不维护本地副本', () => {
  const selector = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/field-config/FieldTypeSelector.tsx'),
    'utf8',
  )
  const formHook = fs.readFileSync(
    path.resolve(process.cwd(), 'src/hooks/useFieldConfigForm.ts'),
    'utf8',
  )

  assert.match(selector, /isPrimaryFieldAllowedType/)
  assert.match(selector, /from '@tabtin\/table-core'/)
  assert.doesNotMatch(selector, /const PRIMARY_FIELD_ALLOWED_TYPES/)
  assert.doesNotMatch(selector, /'rating',\s*'select'/)

  assert.match(formHook, /PRIMARY_FIELD_ALLOWED_TYPES/)
  assert.match(formHook, /from '@tabtin\/table-core'/)
  assert.doesNotMatch(formHook, /const PRIMARY_FIELD_ALLOWED_TYPES/)
})

test('右键/画布菜单：不可主字段类型隐藏「设为主字段」', () => {
  const contextMenu = fs.readFileSync(
    path.resolve(
      process.cwd(),
      '../../apps/tabtin-electron/src/renderer/src/components/field/FieldContextMenu.tsx',
    ),
    'utf8',
  )
  const canvasMenu = fs.readFileSync(
    path.resolve(process.cwd(), '../table-engine-canvas/src/overlays/FieldMenu.tsx'),
    'utf8',
  )
  const management = fs.readFileSync(
    path.resolve(
      process.cwd(),
      '../../apps/tabtin-electron/src/renderer/src/components/field/FieldManagementDialog.tsx',
    ),
    'utf8',
  )

  assert.match(
    contextMenu,
    /isPrimaryFieldAllowedType\(field\.field_type\) \? \([\s\S]*setPrimaryField/,
  )
  assert.match(
    canvasMenu,
    /\(!hasPrimary && !isPrimaryFieldAllowedType\(fieldType\)\)/,
  )
  assert.match(management, /\{canSetPrimary && \(/)
})
