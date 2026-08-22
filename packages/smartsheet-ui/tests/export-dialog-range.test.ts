import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveInitialExportRange,
  supportsExportFieldSelection,
} from '../src/components/export-dialog'

test('export dialog defaults to current view when an active view is available', () => {
  assert.equal(resolveInitialExportRange('view', true, 0), 'view')
})

test('export dialog falls back to all records when current view is unavailable', () => {
  assert.equal(resolveInitialExportRange('view', false, 0), 'all')
})

test('export dialog does not default to selected records when selection is empty', () => {
  assert.equal(resolveInitialExportRange('selected', true, 0), 'view')
  assert.equal(resolveInitialExportRange('selected', false, 0), 'all')
})

test('enabled export formats expose field selection', () => {
  assert.equal(supportsExportFieldSelection('csv'), true)
  assert.equal(supportsExportFieldSelection('excel'), true)
  assert.equal(supportsExportFieldSelection('pdf'), true)
})
