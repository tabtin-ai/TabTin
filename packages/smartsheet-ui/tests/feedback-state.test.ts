import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmptyState } from '../src/components/common/empty-state'
import { PanelLoadingState } from '../src/components/common/panel-loading-state'
import { StatusNotice } from '../src/components/common/status-notice'

test('EmptyState supports card layout and ReactNode title', () => {
  const html = renderToStaticMarkup(
    React.createElement(EmptyState, {
      icon: 'inbox',
      title: React.createElement('strong', null, '暂无内容'),
      description: React.createElement('span', null, '稍后再来'),
      layout: 'card',
      tone: 'warning',
      size: 'sm',
    }),
  )

  assert.match(html, /rounded-lg/)
  assert.match(html, /border-warning\/20/)
  assert.match(html, /暂无内容/)
  assert.match(html, /稍后再来/)
})

test('StatusNotice renders semantic tone styles', () => {
  const html = renderToStaticMarkup(
    React.createElement(StatusNotice, {
      tone: 'danger',
      title: '加载失败',
      description: '请稍后重试',
    }),
  )

  assert.match(html, /bg-destructive\/10/)
  assert.match(html, /加载失败/)
  assert.match(html, /请稍后重试/)
})

test('PanelLoadingState renders detail skeleton blocks', () => {
  const html = renderToStaticMarkup(
    React.createElement(PanelLoadingState, {
      variant: 'detail',
      rows: 4,
    }),
  )

  assert.match(html, /rounded-xl/)
  assert.match(html, /animate-pulse/)
})
