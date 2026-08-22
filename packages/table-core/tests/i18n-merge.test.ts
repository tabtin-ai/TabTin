import assert from 'node:assert/strict'
import test from 'node:test'
import { deepMergeLocaleObjects } from '../src'

test('deepMergeLocaleObjects 应递归合并嵌套对象，且 override 覆盖 base', () => {
  const merged = deepMergeLocaleObjects(
    {
      record: {
        createFailedTitle: '创建失败',
        dialog: {
          createTitle: '新建记录',
          createDescription: '创建描述',
        },
      },
      skill: {
        statusPending: 'AI 排队中',
      },
    },
    {
      record: {
        dialog: {
          createTitle: '添加记录',
        },
      },
      skill: {
        statusPending: '排队中',
      },
    },
  )

  assert.deepEqual(merged, {
    record: {
      createFailedTitle: '创建失败',
      dialog: {
        createTitle: '添加记录',
        createDescription: '创建描述',
      },
    },
    skill: {
      statusPending: '排队中',
    },
  })
})

test('deepMergeLocaleObjects 遇到非对象值时应整体覆盖', () => {
  const merged = deepMergeLocaleObjects(
    {
      record: {
        history: {
          open: '查看历史',
        },
      },
      actions: {
        cancelDraft: '取消',
      },
    },
    {
      record: {
        history: 'history',
      },
      actions: {
        cancelDraft: ['cancel'],
      },
    },
  )

  assert.deepEqual(merged, {
    record: {
      history: 'history',
    },
    actions: {
      cancelDraft: ['cancel'],
    },
  })
})
