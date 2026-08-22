/**
 * B1-01 P0 回归测试 — 协同编辑 LWW 覆盖缓解
 *
 * 验证：
 * 1. TextElement 外部同步 effect 包含 autoSnapshotTimerRef 防护
 * 2. flush-text-edit 事件先清空 timer 再 flush，确保 undo/redo 不被误拦
 * 3. onUpdate 回调设置 debounce timer，标记活跃编辑状态
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const textElementSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/elements/TextElement.tsx'),
  'utf-8',
)

/* ── B1-01: 外部同步 effect 中存在 LWW 防护 ── */

describe('B1-01: TextElement LWW mitigation guard', () => {
  it('checks autoSnapshotTimerRef before calling setContent', () => {
    // 外部同步 effect 中应先检查 autoSnapshotTimerRef.current !== null
    expect(textElementSrc).toContain('autoSnapshotTimerRef.current !== null')
  })

  it('returns early when autoSnapshotTimerRef is active (skips external sync)', () => {
    const guardPattern = /autoSnapshotTimerRef\.current\s*!==\s*null\s*\|\|\s*editor\.isFocused\)\s*\{[\s\S]*?return[\s\S]*?\}/
    expect(textElementSrc).toMatch(guardPattern)
  })

  it('setContent is called only after the guard passes', () => {
    // 找到外部同步 effect 的代码块
    const effectBlock = textElementSrc.match(
      /外部 store 变化[\s\S]*?element\.content,\s*editor\]/,
    )
    expect(effectBlock).toBeTruthy()
    const block = effectBlock![0]

    // autoSnapshotTimerRef 检查必须出现在 setContent 之前
    const guardIdx = block.indexOf('autoSnapshotTimerRef.current !== null')
    const setContentIdx = block.indexOf('editor.commands.setContent')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(setContentIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(setContentIdx)
  })
})

/* ── B1-01: flush-text-edit 事件处理确保 undo/redo 兼容 ── */

describe('B1-01: flush-text-edit clears timer before flush', () => {
  it('flush handler clears autoSnapshotTimerRef before calling flushTextToStore', () => {
    // 找到 flush-text-edit 事件监听的 handler
    const handlerBlock = textElementSrc.match(
      /const handler\s*=\s*\(\)\s*=>\s*\{[\s\S]*?flushTextToStore\(\)[\s\S]*?\}/,
    )
    expect(handlerBlock).toBeTruthy()
    const block = handlerBlock![0]

    // clearTimeout 必须在 flushTextToStore 之前
    const clearIdx = block.indexOf('clearTimeout(autoSnapshotTimerRef.current)')
    const flushIdx = block.indexOf('flushTextToStore()')
    expect(clearIdx).toBeGreaterThan(-1)
    expect(flushIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeLessThan(flushIdx)
  })

  it('flush handler sets autoSnapshotTimerRef to null', () => {
    const handlerBlock = textElementSrc.match(
      /const handler\s*=\s*\(\)\s*=>\s*\{[\s\S]*?flushTextToStore\(\)[\s\S]*?\}/,
    )
    expect(handlerBlock).toBeTruthy()
    expect(handlerBlock![0]).toContain('autoSnapshotTimerRef.current = null')
  })
})

/* ── B1-01: onUpdate 设置 debounce timer 标记活跃编辑 ── */

describe('B1-01: onUpdate debounce marks active editing', () => {
  it('onUpdate sets autoSnapshotTimerRef via setTimeout', () => {
    // onUpdate 中应设置 debounce timer
    const updateBlock = textElementSrc.match(
      /onUpdate:\s*\(\{\s*editor:\s*ed\s*\}\)\s*=>\s*\{[\s\S]*?setTimeout[\s\S]*?\}/,
    )
    expect(updateBlock).toBeTruthy()
  })

  it('debounce timer calls flushTextToStore', () => {
    const updateBlock = textElementSrc.match(
      /onUpdate:[\s\S]*?setTimeout\([\s\S]*?flushTextToStore[\s\S]*?\},\s*\d+\)/,
    )
    expect(updateBlock).toBeTruthy()
  })

  it('latestHtmlRef is updated in onUpdate before any debounce', () => {
    // latestHtmlRef.current = ed.getHTML() 应出现在 setTimeout 之前
    const updateBlock = textElementSrc.match(
      /onUpdate:\s*\(\{\s*editor:\s*ed\s*\}\)\s*=>\s*\{([\s\S]*?)\}\s*\n\s*\}/,
    )
    expect(updateBlock).toBeTruthy()
    const block = updateBlock![1]
    const refIdx = block.indexOf('latestHtmlRef.current = ed.getHTML()')
    const timerIdx = block.indexOf('setTimeout')
    expect(refIdx).toBeGreaterThan(-1)
    expect(timerIdx).toBeGreaterThan(-1)
    expect(refIdx).toBeLessThan(timerIdx)
  })
})
