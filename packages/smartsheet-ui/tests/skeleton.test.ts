import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Skeleton } from '../src/components/skeleton'

test('Skeleton renders size styles and rounded class', () => {
  const html = renderToStaticMarkup(
    React.createElement(Skeleton, {
      width: 24,
      height: '2rem',
      rounded: 'full',
      className: 'custom-skeleton',
    }),
  )

  assert.match(html, /custom-skeleton/)
  assert.match(html, /rounded-full/)
  assert.match(html, /width:24px/)
  assert.match(html, /height:2rem/)
})
