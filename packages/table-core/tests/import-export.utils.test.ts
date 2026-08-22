import assert from 'node:assert/strict'
import test from 'node:test'
import { ImportExportApiService } from '../src'

// getFileExtension is internal; mirror logic for testing
function getFileExtension(file: { name: string }): string {
  return file.name.split('.').pop()?.toLowerCase() ?? ''
}

test('generateFilename: csv format', () => {
  const filename = ImportExportApiService.generateFilename('测试表', 'csv')
  assert.ok(filename.startsWith('测试表_'))
  assert.ok(filename.endsWith('.csv'))
})

test('generateFilename: excel format', () => {
  const filename = ImportExportApiService.generateFilename('Sales', 'excel')
  assert.ok(filename.endsWith('.xlsx'))
})

test('generateFilename: pdf format', () => {
  const filename = ImportExportApiService.generateFilename('Report', 'pdf')
  assert.ok(filename.endsWith('.pdf'))
})

test('export: json format is disabled', async () => {
  await assert.rejects(
    () => ImportExportApiService.export('json', { table_id: 'table-1' }),
    /JSON 导出已关闭/,
  )
})

test('exportJSON: direct json export is disabled', async () => {
  await assert.rejects(
    () => ImportExportApiService.exportJSON({ table_id: 'table-1' }),
    /JSON 导出已关闭/,
  )
})

test('getFileExtension: json file', () => {
  assert.equal(getFileExtension({ name: 'data.json' }), 'json')
})

test('generateFilename: contains timestamp', () => {
  const filename = ImportExportApiService.generateFilename('Table', 'csv')
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(filename))
})

test('getFileExtension: normal file', () => {
  assert.equal(getFileExtension({ name: 'data.csv' }), 'csv')
})

test('getFileExtension: xlsx file', () => {
  assert.equal(getFileExtension({ name: 'report.xlsx' }), 'xlsx')
})

test('getFileExtension: no extension', () => {
  assert.equal(getFileExtension({ name: 'Makefile' }), 'makefile')
})

test('getFileExtension: compound extension', () => {
  assert.equal(getFileExtension({ name: 'archive.tar.gz' }), 'gz')
})

test('getFileExtension: uppercase', () => {
  assert.equal(getFileExtension({ name: 'DATA.CSV' }), 'csv')
})
