import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FIELD_MANAGEMENT_CONTENT_CLASS_NAME,
  FIELD_MANAGEMENT_LIST_CLASS_NAME,
  FIELD_MANAGEMENT_SUMMARY_CLASS_NAME,
} from './fieldManagementLayout.ts'

test('field management fits and scrolls within a narrow dynamic viewport', () => {
  assert.match(FIELD_MANAGEMENT_CONTENT_CLASS_NAME, /w-\[calc\(100%_-_2rem\)\]/)
  assert.match(FIELD_MANAGEMENT_CONTENT_CLASS_NAME, /max-h-\[calc\(100dvh_-_2rem\)\]/)
  assert.match(FIELD_MANAGEMENT_CONTENT_CLASS_NAME, /min-h-0/)
  assert.match(FIELD_MANAGEMENT_CONTENT_CLASS_NAME, /overflow-hidden/)
  assert.match(FIELD_MANAGEMENT_SUMMARY_CLASS_NAME, /flex-col/)
  assert.match(FIELD_MANAGEMENT_SUMMARY_CLASS_NAME, /sm:flex-row/)
  assert.match(FIELD_MANAGEMENT_LIST_CLASS_NAME, /min-h-0/)
  assert.match(FIELD_MANAGEMENT_LIST_CLASS_NAME, /flex-1/)
})
