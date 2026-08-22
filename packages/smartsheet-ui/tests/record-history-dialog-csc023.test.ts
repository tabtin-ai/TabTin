import assert from 'node:assert/strict'
import test from 'node:test'
import { setSmartsheetUiLocale as setLocale, t } from '../src/i18n'

// CSC-023 回归测试：recordHistoryDialog.action.restore i18n key 补全
// 验证 restore 操作的 badge 文案在 zh-CN 和 en-US 下均有正确翻译

test('CSC-023: recordHistoryDialog.action.restore key exists in zh-CN', () => {
  setLocale('zh-CN')
  const label = t('recordHistoryDialog.action.restore')
  assert.equal(label, '恢复', 'zh-CN restore action label should be 恢复')
})

test('CSC-023: recordHistoryDialog.action.restore key exists in en-US', () => {
  setLocale('en-US')
  const label = t('recordHistoryDialog.action.restore')
  assert.equal(label, 'Restore', 'en-US restore action label should be Restore')
})

test('CSC-023: existing action keys still work after adding restore', () => {
  setLocale('en-US')
  assert.equal(t('recordHistoryDialog.action.create'), 'Create')
  assert.equal(t('recordHistoryDialog.action.update'), 'Update')
  assert.equal(t('recordHistoryDialog.action.delete'), 'Delete')
  assert.equal(t('recordHistoryDialog.action.restore'), 'Restore')
})

test('CSC-023: zh-CN existing action keys still work after adding restore', () => {
  setLocale('zh-CN')
  assert.equal(t('recordHistoryDialog.action.create'), '创建')
  assert.equal(t('recordHistoryDialog.action.update'), '更新')
  assert.equal(t('recordHistoryDialog.action.delete'), '删除')
  assert.equal(t('recordHistoryDialog.action.restore'), '恢复')
})

test('CSC-023: unknown action key falls back to key string (not empty)', () => {
  setLocale('en-US')
  const unknownKey = 'recordHistoryDialog.action.unknown_action'
  const result = t(unknownKey)
  // 应该 fallback 到 key 本身，而不是空字符串
  assert.ok(result.length > 0, 'fallback should not be empty')
})
