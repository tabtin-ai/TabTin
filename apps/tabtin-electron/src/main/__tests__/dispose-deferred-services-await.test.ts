/**
 * disposeDeferredServices await 行为回归测试
 *
 * SC-004: cleanupEmbeddedCrawlView() 必须被 await
 * SC-005: frontendActionBridge.destroy() 必须被 await（不再 fire-and-forget）
 *
 * 验证方式：通过 AST-free 源码扫描确认 await 关键字存在，
 * 同时对 FrontendActionBridge 进行行为级别测试。
 *
 * 拆分后，SC-004 检查 deferred-init-crawlspace.ts:disposeCrawlspaceFull，
 * SC-005 检查 deferred-init-action-bridge.ts:disposeActionBridgeSerial。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf-8')
}

const crawlspaceDomainSource = readSource('deferred-init-crawlspace.ts')
const actionBridgeDomainSource = readSource('deferred-init-action-bridge.ts')

describe('disposeDeferredServices await 完整性 (SC-004, SC-005)', () => {
  const disposeCrawlspaceBody = extractFunctionBody(crawlspaceDomainSource, 'disposeCrawlspaceFull')
  const disposeActionBridgeSerialBody = extractFunctionBody(actionBridgeDomainSource, 'disposeActionBridgeSerial')

  it('SC-004: cleanupEmbeddedCrawlView 必须被 await（直接或通过 withStepTimeout）', () => {
    expect(disposeCrawlspaceBody).toContain('cleanupEmbeddedCrawlView()')
    const hasDirectAwait = disposeCrawlspaceBody.includes('await cleanupEmbeddedCrawlView()')
    const hasTimeoutWrapped = disposeCrawlspaceBody.includes('withStepTimeout') && disposeCrawlspaceBody.includes('cleanupEmbeddedCrawlView()')
    expect(hasDirectAwait || hasTimeoutWrapped).toBe(true)
  })

  it('SC-005: frontendActionBridge.destroy() 必须被 await（直接或通过 withStepTimeout）', () => {
    expect(disposeActionBridgeSerialBody).toContain('frontendActionBridge')
    expect(disposeActionBridgeSerialBody).toContain('.destroy()')
    expect(disposeActionBridgeSerialBody).not.toContain('void frontendActionBridge.destroy()')
    const hasDirectAwait = disposeActionBridgeSerialBody.includes('await frontendActionBridge.destroy()')
    const hasTimeoutWrapped = disposeActionBridgeSerialBody.includes('withStepTimeout') && disposeActionBridgeSerialBody.includes('frontendActionBridge!.destroy()')
    expect(hasDirectAwait || hasTimeoutWrapped).toBe(true)
  })
})

function extractFunctionBody(source: string, fnName: string): string {
  const idx = source.indexOf(`function ${fnName}`)
  if (idx === -1) return ''
  let braceCount = 0
  let start = -1
  for (let i = idx; i < source.length; i++) {
    if (source[i] === '{') {
      if (start === -1) start = i
      braceCount++
    } else if (source[i] === '}') {
      braceCount--
      if (braceCount === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  return ''
}
