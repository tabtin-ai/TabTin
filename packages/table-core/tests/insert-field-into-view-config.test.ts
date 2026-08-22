import assert from 'node:assert/strict'
import test from 'node:test'
import { insertFieldIntoViewConfig } from '../src/domain/insert-field-into-view-config'

const ACTIVE = ['title', 'picture', 'image', 'www', 'one']

test('insert before middle column reorders column_meta continuously', () => {
  const result = insertFieldIntoViewConfig({
    fieldId: 'new',
    referenceFieldId: 'image',
    position: 'before',
    viewType: 'grid',
    columnMeta: {
      title: { order: 0, hidden: false, width: 120 },
      picture: { order: 1, hidden: false },
      image: { order: 2, hidden: false },
      www: { order: 3, hidden: false },
      one: { order: 4, hidden: false },
    },
    activeFieldIdsByOrder: ACTIVE,
  })

  assert.deepEqual(
    Object.keys(result.column_meta).sort(
      (a, b) => (result.column_meta[a].order ?? 0) - (result.column_meta[b].order ?? 0),
    ),
    ['title', 'picture', 'new', 'image', 'www', 'one'],
  )
  assert.equal(result.column_meta.new.order, 2)
  assert.equal(result.column_meta.new.hidden, false)
  assert.equal(result.column_meta.title.width, 120)
  assert.equal(result.column_meta.image.order, 3)
  assert.equal(result.visible_fields, undefined)
  assert.equal(result.field_order, undefined)
})

test('insert after middle column places new field to the right', () => {
  const result = insertFieldIntoViewConfig({
    fieldId: 'new',
    referenceFieldId: 'image',
    position: 'after',
    viewType: 'grid',
    columnMeta: {
      title: { order: 0, hidden: false },
      picture: { order: 1, hidden: false },
      image: { order: 2, hidden: false },
      www: { order: 3, hidden: false },
      one: { order: 4, hidden: false },
    },
    activeFieldIdsByOrder: ACTIVE,
  })

  assert.deepEqual(
    Object.keys(result.column_meta).sort(
      (a, b) => (result.column_meta[a].order ?? 0) - (result.column_meta[b].order ?? 0),
    ),
    ['title', 'picture', 'image', 'new', 'www', 'one'],
  )
  assert.equal(result.column_meta.new.order, 3)
})

test('reference missing from column_meta falls back to field_order', () => {
  const result = insertFieldIntoViewConfig({
    fieldId: 'new',
    referenceFieldId: 'image',
    position: 'before',
    viewType: 'grid',
    columnMeta: {
      title: { order: 0, hidden: false },
      picture: { order: 1, hidden: false },
    },
    fieldOrder: ['title', 'picture', 'image', 'www', 'one'],
    activeFieldIdsByOrder: ACTIVE,
  })

  assert.deepEqual(
    Object.keys(result.column_meta).sort(
      (a, b) => (result.column_meta[a].order ?? 0) - (result.column_meta[b].order ?? 0),
    ),
    ['title', 'picture', 'new', 'image', 'www', 'one'],
  )
})

test('idempotent when fieldId already in column_meta', () => {
  const columnMeta = {
    title: { order: 0, hidden: false },
    new: { order: 1, hidden: false, width: 80 },
    image: { order: 2, hidden: false },
  }
  const result = insertFieldIntoViewConfig({
    fieldId: 'new',
    referenceFieldId: 'image',
    position: 'before',
    viewType: 'grid',
    columnMeta,
    activeFieldIdsByOrder: ['title', 'new', 'image'],
  })

  assert.equal(result.column_meta, columnMeta)
  assert.equal(result.column_meta.new.width, 80)
})

test('non-grid view writes visible:true for new field', () => {
  const result = insertFieldIntoViewConfig({
    fieldId: 'new',
    referenceFieldId: 'a',
    position: 'after',
    viewType: 'kanban',
    columnMeta: {
      a: { order: 0, visible: true },
      b: { order: 1, visible: true },
    },
    activeFieldIdsByOrder: ['a', 'b'],
  })

  assert.equal(result.column_meta.new.visible, true)
  assert.equal(result.column_meta.new.hidden, undefined)
  assert.equal(result.column_meta.new.order, 1)
  assert.equal(result.column_meta.b.order, 2)
})

test('patches non-empty visible_fields and field_order', () => {
  const result = insertFieldIntoViewConfig({
    fieldId: 'new',
    referenceFieldId: 'image',
    position: 'after',
    viewType: 'grid',
    columnMeta: {
      title: { order: 0, hidden: false },
      image: { order: 1, hidden: false },
      www: { order: 2, hidden: false },
    },
    visibleFields: ['title', 'image', 'www'],
    fieldOrder: ['title', 'image', 'www'],
    activeFieldIdsByOrder: ['title', 'image', 'www'],
  })

  assert.deepEqual(result.visible_fields, ['title', 'image', 'new', 'www'])
  assert.deepEqual(result.field_order, ['title', 'image', 'new', 'www'])
  assert.equal(result.column_meta.new.order, 2)
})
