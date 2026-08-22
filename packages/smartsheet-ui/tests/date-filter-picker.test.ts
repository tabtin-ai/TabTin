/**
 * DateFilterPicker 纯逻辑测试
 *
 * 不依赖 React 渲染，直接测试组件内回调函数的核心逻辑：
 * - handleModeChange: mode 切换后 value 结构是否正确
 * - handleNumberChange: numberOfDays 边界 clamp 逻辑
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// ── 从源码提取的类型 & 常量 ──

type DateFilterMode =
  | 'today' | 'yesterday' | 'tomorrow'
  | 'thisWeek' | 'lastWeek' | 'nextWeek'
  | 'thisMonth' | 'lastMonth' | 'nextMonth'
  | 'thisYear' | 'lastYear' | 'nextYear'
  | 'pastDays' | 'nextDays'
  | 'exactDate' | 'dateRange'

interface DateFilterValue {
  mode: DateFilterMode
  numberOfDays?: number
  exactDate?: string
  exactDateEnd?: string
  timeZone: string
}

const INPUT_MODES: DateFilterMode[] = ['pastDays', 'nextDays']
const PICKER_MODES: DateFilterMode[] = ['exactDate']
const RANGE_MODES: DateFilterMode[] = ['dateRange']

const isInputMode = (mode: DateFilterMode): boolean => INPUT_MODES.includes(mode)
const isPickerMode = (mode: DateFilterMode): boolean => PICKER_MODES.includes(mode)
const isRangeMode = (mode: DateFilterMode): boolean => RANGE_MODES.includes(mode)

// ── 从组件提取的核心逻辑 ──

function simulateHandleModeChange(
  nextMode: DateFilterMode,
  currentValue: DateFilterValue,
): DateFilterValue {
  const base: DateFilterValue = {
    mode: nextMode,
    timeZone: currentValue.timeZone || 'UTC',
  }
  if (isInputMode(nextMode)) {
    base.numberOfDays = currentValue.numberOfDays ?? 7
  } else if (isPickerMode(nextMode)) {
    base.exactDate = currentValue.exactDate ?? ''
  } else if (isRangeMode(nextMode)) {
    base.exactDate = currentValue.exactDate ?? ''
    base.exactDateEnd = currentValue.exactDateEnd ?? ''
  }
  return base
}

function simulateHandleNumberChange(
  rawValue: string,
  currentValue: DateFilterValue,
): DateFilterValue {
  const num = parseInt(rawValue, 10)
  return {
    ...currentValue,
    numberOfDays: Number.isNaN(num) || num < 1 ? 1 : Math.min(num, 365),
  }
}

// ── handleModeChange 测试 ──

const BASE_VALUE: DateFilterValue = {
  mode: 'today',
  timeZone: 'Asia/Shanghai',
}

test('handleModeChange: preset mode → only mode + timeZone', () => {
  const presets: DateFilterMode[] = [
    'today', 'yesterday', 'tomorrow',
    'thisWeek', 'lastWeek', 'nextWeek',
    'thisMonth', 'lastMonth', 'nextMonth',
    'thisYear', 'lastYear', 'nextYear',
  ]
  for (const mode of presets) {
    const result = simulateHandleModeChange(mode, BASE_VALUE)
    assert.equal(result.mode, mode)
    assert.equal(result.timeZone, 'Asia/Shanghai')
    assert.equal(result.numberOfDays, undefined, `${mode} should not have numberOfDays`)
    assert.equal(result.exactDate, undefined, `${mode} should not have exactDate`)
    assert.equal(result.exactDateEnd, undefined, `${mode} should not have exactDateEnd`)
  }
})

test('handleModeChange: pastDays → includes numberOfDays default 7', () => {
  const result = simulateHandleModeChange('pastDays', BASE_VALUE)
  assert.equal(result.mode, 'pastDays')
  assert.equal(result.numberOfDays, 7)
  assert.equal(result.exactDate, undefined)
})

test('handleModeChange: nextDays → includes numberOfDays default 7', () => {
  const result = simulateHandleModeChange('nextDays', BASE_VALUE)
  assert.equal(result.mode, 'nextDays')
  assert.equal(result.numberOfDays, 7)
})

test('handleModeChange: pastDays preserves existing numberOfDays', () => {
  const current: DateFilterValue = { ...BASE_VALUE, numberOfDays: 30 }
  const result = simulateHandleModeChange('pastDays', current)
  assert.equal(result.numberOfDays, 30)
})

test('handleModeChange: exactDate → includes exactDate', () => {
  const result = simulateHandleModeChange('exactDate', BASE_VALUE)
  assert.equal(result.mode, 'exactDate')
  assert.equal(result.exactDate, '')
  assert.equal(result.numberOfDays, undefined)
  assert.equal(result.exactDateEnd, undefined)
})

test('handleModeChange: exactDate preserves existing exactDate', () => {
  const current: DateFilterValue = { ...BASE_VALUE, exactDate: '2026-03-05' }
  const result = simulateHandleModeChange('exactDate', current)
  assert.equal(result.exactDate, '2026-03-05')
})

test('handleModeChange: dateRange → includes exactDate + exactDateEnd', () => {
  const result = simulateHandleModeChange('dateRange', BASE_VALUE)
  assert.equal(result.mode, 'dateRange')
  assert.equal(result.exactDate, '')
  assert.equal(result.exactDateEnd, '')
  assert.equal(result.numberOfDays, undefined)
})

test('handleModeChange: dateRange preserves existing date range', () => {
  const current: DateFilterValue = {
    ...BASE_VALUE,
    exactDate: '2026-01-01',
    exactDateEnd: '2026-12-31',
  }
  const result = simulateHandleModeChange('dateRange', current)
  assert.equal(result.exactDate, '2026-01-01')
  assert.equal(result.exactDateEnd, '2026-12-31')
})

test('handleModeChange: falls back to UTC when timeZone is empty', () => {
  const current: DateFilterValue = { mode: 'today', timeZone: '' }
  const result = simulateHandleModeChange('tomorrow', current)
  assert.equal(result.timeZone, 'UTC')
})

// ── handleNumberChange (clamp 逻辑) 测试 ──

const DAYS_VALUE: DateFilterValue = {
  mode: 'pastDays',
  timeZone: 'UTC',
  numberOfDays: 7,
}

test('handleNumberChange: normal value within range', () => {
  const result = simulateHandleNumberChange('30', DAYS_VALUE)
  assert.equal(result.numberOfDays, 30)
})

test('handleNumberChange: min boundary = 1', () => {
  const result = simulateHandleNumberChange('1', DAYS_VALUE)
  assert.equal(result.numberOfDays, 1)
})

test('handleNumberChange: max boundary = 365', () => {
  const result = simulateHandleNumberChange('365', DAYS_VALUE)
  assert.equal(result.numberOfDays, 365)
})

test('handleNumberChange: clamps value above 365 to 365', () => {
  const result = simulateHandleNumberChange('999', DAYS_VALUE)
  assert.equal(result.numberOfDays, 365)
})

test('handleNumberChange: clamps 0 to 1', () => {
  const result = simulateHandleNumberChange('0', DAYS_VALUE)
  assert.equal(result.numberOfDays, 1)
})

test('handleNumberChange: clamps negative to 1', () => {
  const result = simulateHandleNumberChange('-5', DAYS_VALUE)
  assert.equal(result.numberOfDays, 1)
})

test('handleNumberChange: NaN input defaults to 1', () => {
  const result = simulateHandleNumberChange('abc', DAYS_VALUE)
  assert.equal(result.numberOfDays, 1)
})

test('handleNumberChange: empty string defaults to 1', () => {
  const result = simulateHandleNumberChange('', DAYS_VALUE)
  assert.equal(result.numberOfDays, 1)
})

test('handleNumberChange: preserves other fields from currentValue', () => {
  const current: DateFilterValue = {
    mode: 'pastDays',
    timeZone: 'America/New_York',
    numberOfDays: 7,
    exactDate: '2026-01-01',
  }
  const result = simulateHandleNumberChange('14', current)
  assert.equal(result.mode, 'pastDays')
  assert.equal(result.timeZone, 'America/New_York')
  assert.equal(result.exactDate, '2026-01-01')
  assert.equal(result.numberOfDays, 14)
})
