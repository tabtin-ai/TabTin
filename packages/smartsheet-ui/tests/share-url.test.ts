import assert from 'node:assert/strict'
import test from 'node:test'
import { buildShareUrl } from '../src/share-dialog/url'

test('buildShareUrl requires an explicit public web prefix', () => {
  assert.equal(buildShareUrl('wwfosw-YzR_NBPYl'), '')
  assert.equal(buildShareUrl('wwfosw-YzR_NBPYl', ''), '')
})

test('buildShareUrl joins the configured public web prefix and share id', () => {
  assert.equal(
    buildShareUrl('wwfosw-YzR_NBPYl', 'https://api-preprod.example.com/shared/docs/'),
    'https://api-preprod.example.com/shared/docs/wwfosw-YzR_NBPYl',
  )
})
