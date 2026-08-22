import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import {
  buildImportTemplateBlob,
  buildImportTemplateContent,
  isValidJsonImportTemplate,
} from '../src/data/services/import-template'

const fields = [
  { name: '标题', field_type: 'text' },
  { name: '金额', field_type: 'number' },
]

test('buildImportTemplateContent json: at least 2 rows so header/row axis is obvious', () => {
  const { content, extension, mimeType } = buildImportTemplateContent(fields, 'json')
  assert.equal(extension, 'json')
  assert.ok(mimeType.includes('application/json'))
  assert.ok(isValidJsonImportTemplate(content))
  const parsed = JSON.parse(content) as Array<Record<string, unknown>>
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]['标题'], '示例文本1')
  assert.equal(parsed[0]['金额'], 123)
  assert.equal(parsed[1]['标题'], '示例文本2')
  assert.equal(parsed[1]['金额'], 456)
})

test('buildImportTemplateContent csv: BOM + header + two example rows', () => {
  const { content, extension } = buildImportTemplateContent(fields, 'csv')
  assert.equal(extension, 'csv')
  assert.ok(content.startsWith('\ufeff'))
  assert.ok(content.includes('标题,金额'))
  assert.ok(content.includes('示例文本1'))
  assert.ok(content.includes('示例文本2'))
  assert.ok(!isValidJsonImportTemplate(content))
})

test('isValidJsonImportTemplate rejects CSV masquerading as json', () => {
  assert.equal(isValidJsonImportTemplate('标题\n示例文本\n'), false)
  assert.equal(isValidJsonImportTemplate('\ufeff标题\n示例文本\n'), false)
})

test('buildImportTemplateBlob xlsx: workbook preserves headers and example rows', async () => {
  const blob = buildImportTemplateBlob(fields, 'xlsx')
  assert.equal(
    blob.type,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )

  const workbook = XLSX.read(await blob.arrayBuffer(), { type: 'array' })
  assert.deepEqual(workbook.SheetNames, ['导入模板'])

  const worksheet = workbook.Sheets['导入模板']
  const rows = XLSX.utils.sheet_to_json<Array<string | number>>(worksheet, {
    header: 1,
    raw: true,
  })
  assert.deepEqual(rows[0], ['标题', '金额'])
  assert.deepEqual(rows[1], ['示例文本1', 123])
  assert.deepEqual(rows[2], ['示例文本2', 456])
})
