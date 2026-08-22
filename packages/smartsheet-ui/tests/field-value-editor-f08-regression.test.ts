/**
 * 回归测试：FMF-014 / FMF-019
 *
 * - FMF-014: phone 字段应渲染 type="tel" 的 Input
 * - FMF-019: checkbox 无 description 时不应重复显示 field.name
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FieldValueEditor } from '../src/components/field-editor/FieldValueEditor'

const noop = () => {}

// ── FMF-014: phone field renders type="tel" ──

test('FMF-014: phone field input has type="tel"', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: { id: 'f1', name: 'Phone', field_type: 'phone' },
      value: '',
      onChange: noop,
    }),
  )
  assert.match(html, /type="tel"/, 'phone input should have type="tel"')
})

test('FMF-014: email field still has type="email"', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: { id: 'f2', name: 'Email', field_type: 'email' },
      value: '',
      onChange: noop,
    }),
  )
  assert.match(html, /type="email"/)
})

test('FMF-014: url field still has type="url"', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: { id: 'f3', name: 'URL', field_type: 'url' },
      value: '',
      onChange: noop,
    }),
  )
  assert.match(html, /type="url"/)
})

test('FMF-014: text field still has type="text"', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: { id: 'f4', name: 'Name', field_type: 'text' },
      value: '',
      onChange: noop,
    }),
  )
  assert.match(html, /type="text"/)
})

// ── FMF-019: checkbox label not duplicated ──

test('FMF-019: checkbox without description does not render field.name in label', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: { id: 'f5', name: 'MyCheckbox', field_type: 'checkbox' },
      value: false,
      onChange: noop,
    }),
  )
  const labelMatches = html.match(/MyCheckbox/g)
  assert.ok(
    !labelMatches || labelMatches.length === 0,
    `checkbox without description should not render field.name inside FieldValueEditor (found ${labelMatches?.length ?? 0} occurrences)`,
  )
})

test('FMF-019: checkbox with description renders description, not field.name', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: { id: 'f6', name: 'AcceptTerms', field_type: 'checkbox', description: 'I agree to the terms' },
      value: true,
      onChange: noop,
    }),
  )
  assert.match(html, /I agree to the terms/, 'should render description')
  const nameMatches = html.match(/AcceptTerms/g)
  assert.ok(
    !nameMatches || nameMatches.length === 0,
    'should not render field.name when description is present',
  )
})

// ── select: searchable combobox trigger () ──

test('select field renders combobox trigger instead of native select listbox', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: {
        id: 'f9',
        name: 'Status',
        field_type: 'select',
        options: {
          choices: [
            { value: 'todo', label: 'Todo' },
            { value: 'done', label: 'Done' },
          ],
        },
      },
      value: '',
      onChange: noop,
    }),
  )
  assert.match(html, /role="combobox"/, 'select should use searchable combobox trigger')
  assert.match(html, /Status/, 'placeholder should include field name')
})

test('select field with value renders clear button labeled (无)', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: {
        id: 'f10',
        name: 'Status',
        field_type: 'select',
        options: {
          choices: [
            { value: 'todo', label: 'Todo' },
            { value: 'done', label: 'Done' },
          ],
        },
      },
      value: 'todo',
      onChange: noop,
    }),
  )
  assert.match(html, /aria-label="\(无\)"/, 'filled select should expose clear control')
  assert.match(html, /role="combobox"/, 'select should still use searchable combobox')
})

test('select field without value does not render clear button', () => {
  const html = renderToStaticMarkup(
    React.createElement(FieldValueEditor, {
      field: {
        id: 'f11',
        name: 'Status',
        field_type: 'select',
        options: {
          choices: [{ value: 'todo', label: 'Todo' }],
        },
      },
      value: '',
      onChange: noop,
    }),
  )
  assert.doesNotMatch(html, /aria-label="\(无\)"/, 'empty select should not show clear')
})
