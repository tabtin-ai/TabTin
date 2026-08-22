import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTabDataNativeFocusPayload,
  hasNativeFocusHost,
  reportNativeFocus,
  resolveTabDataNativeFocusReport,
  type NativeFocusPayload,
} from './native-focus-bridge.ts'

test('buildTabDataNativeFocusPayload 把空/undefined view 归一成 null', () => {
  assert.deepEqual(buildTabDataNativeFocusPayload('table-1', undefined), {
    appType: 'tabdata',
    resourceId: 'table-1',
    viewId: null,
  })
  assert.deepEqual(buildTabDataNativeFocusPayload('table-1', null), {
    appType: 'tabdata',
    resourceId: 'table-1',
    viewId: null,
  })
  assert.deepEqual(buildTabDataNativeFocusPayload('table-1', 'view-9'), {
    appType: 'tabdata',
    resourceId: 'table-1',
    viewId: 'view-9',
  })
})

test('非 embedded 不解析出 payload', () => {
  assert.equal(
    resolveTabDataNativeFocusReport({
      isEmbedded: false,
      tableId: 'table-1',
      viewTableId: 'table-1',
      currentViewId: 'view-1',
    }),
    null,
  )
})

test('embedded 但无 tableId 不解析出 payload', () => {
  assert.equal(
    resolveTabDataNativeFocusReport({
      isEmbedded: true,
      tableId: '  ',
      viewTableId: 'table-1',
      currentViewId: 'view-1',
    }),
    null,
  )
})

test('embedded 且 viewStore 已对齐时带上 currentViewId', () => {
  assert.deepEqual(
    resolveTabDataNativeFocusReport({
      isEmbedded: true,
      tableId: 'table-1',
      viewTableId: 'table-1',
      currentViewId: 'view-1',
    }),
    {
      appType: 'tabdata',
      resourceId: 'table-1',
      viewId: 'view-1',
    },
  )
})

test('viewStore 未对齐当前 table 时 viewId 为 null', () => {
  assert.deepEqual(
    resolveTabDataNativeFocusReport({
      isEmbedded: true,
      tableId: 'table-2',
      viewTableId: 'table-1',
      currentViewId: 'stale-view',
    }),
    {
      appType: 'tabdata',
      resourceId: 'table-2',
      viewId: null,
    },
  )
})

test('空串 viewId 不冒充有效视图', () => {
  assert.deepEqual(
    resolveTabDataNativeFocusReport({
      isEmbedded: true,
      tableId: 'table-1',
      viewTableId: 'table-1',
      currentViewId: '   ',
    }),
    {
      appType: 'tabdata',
      resourceId: 'table-1',
      viewId: null,
    },
  )
})

test('有效 viewId 会 trim 后再上报', () => {
  assert.deepEqual(
    resolveTabDataNativeFocusReport({
      isEmbedded: true,
      tableId: ' table-1 ',
      viewTableId: ' table-1 ',
      currentViewId: ' view-1 ',
    }),
    {
      appType: 'tabdata',
      resourceId: 'table-1',
      viewId: 'view-1',
    },
  )
})

test('无 host 时 hasNativeFocusHost 为 false 且 report 为 no-op', () => {
  const g = globalThis as { window?: { __TABTIN_NATIVE_FOCUS__?: unknown } }
  const prev = g.window
  g.window = { __TABTIN_NATIVE_FOCUS__: undefined }

  try {
    assert.equal(hasNativeFocusHost(), false)
    reportNativeFocus({
      appType: 'tabdata',
      resourceId: 'table-1',
      viewId: 'view-1',
    })
  } finally {
    g.window = prev
  }
})

test('有 host 时 report 转发 payload', () => {
  const g = globalThis as { window?: { __TABTIN_NATIVE_FOCUS__?: unknown } }
  const prev = g.window
  const calls: NativeFocusPayload[] = []
  g.window = {
    __TABTIN_NATIVE_FOCUS__: {
      report(payload: NativeFocusPayload) {
        calls.push(payload)
      },
    },
  }

  try {
    assert.equal(hasNativeFocusHost(), true)
    const payload = buildTabDataNativeFocusPayload('table-1', 'view-1')
    reportNativeFocus(payload)
    assert.deepEqual(calls, [payload])
  } finally {
    g.window = prev
  }
})