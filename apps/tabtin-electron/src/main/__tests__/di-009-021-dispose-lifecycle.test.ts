/**
 * DI-009 / DI-021 回归测试
 *
 * DI-009: disposeDeferredServices 每个 async 步骤有独立超时包裹
 *         （拆分为 deferred-services.ts 编排层 + 各域模块）
 * DI-021: app-lifecycle.ts 的退出超时 Timer 不应调用 .unref()
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf-8')
}

const deferredServicesSource = readSource('deferred-services.ts')
const deferredUtilsSource = readSource('deferred-utils.ts')
const crawlspaceDomainSource = readSource('deferred-init-crawlspace.ts')
const actionBridgeDomainSource = readSource('deferred-init-action-bridge.ts')
const miscDomainSource = readSource('deferred-init-misc.ts')
const tinsDomainSource = readSource('deferred-init-tins.ts')
const appLifecycleSource = readSource('app-lifecycle.ts')

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

describe('DI-009: disposeDeferredServices 步骤超时保护', () => {
  const disposeFnBody = extractFunctionBody(deferredServicesSource, 'disposeDeferredServices')
  const disposeCrawlspaceBody = extractFunctionBody(crawlspaceDomainSource, 'disposeCrawlspaceFull')
  const disposeActionBridgeSerialBody = extractFunctionBody(actionBridgeDomainSource, 'disposeActionBridgeSerial')

  it('withStepTimeout 工具函数已定义（deferred-utils.ts）', () => {
    expect(deferredUtilsSource).toContain('async function withStepTimeout')
  })

  it('cleanupEmbeddedCrawlView 应被 withStepTimeout 包裹（crawlspace 域）', () => {
    expect(disposeCrawlspaceBody).toContain('withStepTimeout')
    expect(disposeCrawlspaceBody).toContain('cleanupEmbeddedCrawlView()')
  })

  it('electronAgentService.stop 应被 withStepTimeout 包裹', () => {
    expect(disposeFnBody).toContain("'electronAgentService.stop'")
  })

  it('frontendActionBridge.destroy 应被 withStepTimeout 包裹（action-bridge 域）', () => {
    expect(disposeActionBridgeSerialBody).toContain('withStepTimeout')
    expect(disposeActionBridgeSerialBody).toContain('frontendActionBridge!.destroy()')
  })

  it('EventPersistence.destroy 应被 withStepTimeout 包裹', () => {
    expect(disposeFnBody).toContain("'EventPersistence.destroy'")
  })

  it('TabPhone 模块清理应被 withStepTimeout 包裹（misc 域）', () => {
    expect(miscDomainSource).toContain("'TabPhone 模块清理'")
  })

  it('LocalMcpService.dispose 应被 withStepTimeout 包裹', () => {
    expect(disposeFnBody).toContain("'LocalMcpService.dispose'")
  })

  it('Tins 模块清理应被 withStepTimeout 包裹（tins 域）', () => {
    expect(tinsDomainSource).toContain("'Tins 模块清理'")
  })

  it('endAllRuns 应被 withStepTimeout 包裹 (DI-011)', () => {
    expect(disposeFnBody).toContain("'RunSessionManager.endAllRuns'")
  })
})

describe('DI-021: 退出超时 Timer 不应 .unref()', () => {
  it('CLEANUP_TIMEOUT setTimeout 之后不应有 .unref() 调用', () => {
    const cleanupBlock = appLifecycleSource.match(
      /const CLEANUP_TIMEOUT_MS[\s\S]*?Promise\.resolve\(options\.onBeforeQuit/,
    )
    expect(cleanupBlock).not.toBeNull()
    const block = cleanupBlock![0]
    expect(block).not.toContain('timeoutId.unref()')
    expect(block).not.toContain('.unref()')
  })

  it('SIGINT/SIGTERM 兜底 Timer 仍应保留 .unref()', () => {
    const signalBlock = appLifecycleSource.match(
      /process\.on\(signal[\s\S]*?\.unref\(\)/,
    )
    expect(signalBlock).not.toBeNull()
  })
})
