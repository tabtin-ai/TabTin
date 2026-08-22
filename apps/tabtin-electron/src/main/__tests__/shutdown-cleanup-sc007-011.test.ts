/**
 * shutdown-cleanup 回归测试 (SC-007 ~ SC-011)
 *
 * SC-007: 多窗口竞态 — mainWindow.close() 前检查 isDestroyed()
 * SC-008: clearMainWindow() 必须在 runtimeServices.stop() 之后调用
 * SC-009: RunSessionManager.stopTimeoutChecker() 必须在 disposeDeferredServices 中被调用
 * SC-010: LocalMcpService.dispose() 幂等保护
 * SC-011: TinManager IPC handler 在 disposed 后 early return
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf-8')
}

function extractFunctionBody(source: string, fnName: string): string {
  const regex = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`)
  const match = regex.exec(source)
  if (!match) return ''
  let braceCount = 0
  let start = -1
  for (let i = match.index; i < source.length; i++) {
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

// ── SC-007: 多窗口竞态防护 ───────────────────────

describe('SC-007: 主窗口 close handler 竞态防护', () => {
  const mainWindowSource = readSource('main-window.ts')

  it('flushCompleteHandler 和 forceCloseTimer 中 mainWindow.close() 前必须检查 isDestroyed()', () => {
    // 找到整个 close handler 区域（从 flushCompleteHandler 定义到 ipcMain.on）
    const startIdx = mainWindowSource.indexOf('const flushCompleteHandler')
    const endIdx = mainWindowSource.indexOf("ipcMain.on('slide:flush-complete'", startIdx)
    expect(startIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(startIdx)
    const closeHandlerSection = mainWindowSource.slice(startIdx, endIdx)

    // 统计 mainWindow.close() 出现次数和 isDestroyed() 出现次数
    const closeCallCount = (closeHandlerSection.match(/mainWindow\.close\(\)/g) || []).length
    const destroyedCheckCount = (closeHandlerSection.match(/isDestroyed\(\)/g) || []).length

    // 每个 close() 调用前都应有 isDestroyed() 检查
    expect(closeCallCount).toBeGreaterThanOrEqual(2)
    expect(destroyedCheckCount).toBeGreaterThanOrEqual(2)

    // 不应有裸的 mainWindow.close()（没有 isDestroyed 保护的）
    // 检查方式：每个 close() 出现前最近 80 字符内必须有 isDestroyed
    let searchFrom = 0
    while (true) {
      const closeIdx = closeHandlerSection.indexOf('mainWindow.close()', searchFrom)
      if (closeIdx === -1) break
      const preceding = closeHandlerSection.slice(Math.max(0, closeIdx - 80), closeIdx)
      expect(preceding).toContain('isDestroyed()')
      searchFrom = closeIdx + 1
    }
  })

  it('window-all-closed 中 isQuitting 时不重复调用 app.quit()', () => {
    const lifecycleSource = readSource('app-lifecycle.ts')
    const windowAllClosedIdx = lifecycleSource.indexOf("'window-all-closed'")
    expect(windowAllClosedIdx).toBeGreaterThan(-1)

    // 提取该事件处理器体
    const section = lifecycleSource.slice(
      windowAllClosedIdx,
      windowAllClosedIdx + 300,
    )
    expect(section).toContain('isQuitting')
  })
})

// ── SC-008: clearMainWindow() 调用顺序 ──────────

describe('SC-008: clearMainWindow 必须在 runtimeServices.stop() 之后', () => {
  const handlersSource = readSource('main-app-handlers.ts')

  it('onBeforeQuit 中 runtimeServices.stop() 先于 clearMainWindow()', () => {
    // 找到 onBeforeQuit 的实现（跳过接口定义）
    const quitIdx = handlersSource.indexOf('onBeforeQuit: async')
    expect(quitIdx).toBeGreaterThan(-1)
    const body = handlersSource.slice(quitIdx, quitIdx + 3000)
    const stopIdx = body.indexOf('.stop()')
    const clearIdx = body.indexOf('clearMainWindow()')
    expect(stopIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(-1)
    expect(stopIdx).toBeLessThan(clearIdx)
  })
})

// ── SC-009: RunSessionManager 超时检查器停止 ─────

describe('SC-009: disposeDeferredServices 必须停止 RunSessionManager 超时检查器', () => {
  const deferredSource = readSource('deferred-services.ts')
  const disposeFnBody = extractFunctionBody(deferredSource, 'disposeDeferredServices')

  it('disposeDeferredServices 调用 stopTimeoutChecker()', () => {
    expect(disposeFnBody).toContain('stopTimeoutChecker()')
  })

  it('导入了 getRunSessionManager', () => {
    expect(deferredSource).toContain('getRunSessionManager')
    expect(deferredSource).toContain("import('./run-session/RunSessionManager')")
  })
})

// ── SC-010: LocalMcpService dispose 幂等保护 ─────

describe('SC-010: LocalMcpService.dispose() 幂等', () => {
  const mcpSource = readSource('services/LocalMcpService.ts')

  it('dispose() 有 disposed flag 早返回', () => {
    // 找到 dispose 方法
    const disposeIdx = mcpSource.indexOf('async dispose()')
    expect(disposeIdx).toBeGreaterThan(-1)
    const disposeSection = mcpSource.slice(disposeIdx, disposeIdx + 300)
    expect(disposeSection).toContain('this.disposed')
    expect(disposeSection).toMatch(/if\s*\(\s*this\.disposed\s*\)\s*return/)
  })

  it('类定义包含 disposed 属性', () => {
    const classIdx = mcpSource.indexOf('class LocalMcpService')
    expect(classIdx).toBeGreaterThan(-1)
    const classSection = mcpSource.slice(classIdx, classIdx + 500)
    expect(classSection).toMatch(/private\s+disposed\s*=\s*false/)
  })
})

// ── SC-011: TinManager IPC handler disposed guard ─

describe('SC-011: TinManager IPC handler disposed 早返回', () => {
  const tinManagerSource = readSource('tins/tin-manager.ts')

  // 找到 registerIpcHandlers 方法体
  const methodStartIdx = tinManagerSource.indexOf('private registerIpcHandlers')
  const registerBody = (() => {
    if (methodStartIdx === -1) return ''
    let braceCount = 0
    let start = -1
    for (let i = methodStartIdx; i < tinManagerSource.length; i++) {
      if (tinManagerSource[i] === '{') {
        if (start === -1) start = i
        braceCount++
      } else if (tinManagerSource[i] === '}') {
        braceCount--
        if (braceCount === 0) {
          return tinManagerSource.slice(start, i + 1)
        }
      }
    }
    return ''
  })()

  it('registerIpcHandlers 方法可被定位', () => {
    expect(registerBody.length).toBeGreaterThan(100)
  })

  const channels = [
    'tins:get-activation-states',
    'tins:toggle-panel',
    'tins:set-instances',
    'tins:get-page-context',
    'tins:get-resolved-variables',
    'tins:prepare-sandbox',
    'tins:cleanup-sandbox',
    'tins:sync-page-context',
    'tins:register-webview',
    'tins:unregister-webview',
  ]

  for (const channel of channels) {
    it(`${channel} handler 检查 this.disposed`, () => {
      const channelIdx = registerBody.indexOf(`'${channel}'`)
      expect(channelIdx).toBeGreaterThan(-1)

      // 找到该 handler 的 body（从 channel 出现到下一个 handle/guardedHandle 调用或结尾）
      const restAfterChannel = registerBody.slice(channelIdx + channel.length)
      // 寻找下一个 handler 注册点
      const nextHandleIdx = Math.min(
        ...[
          restAfterChannel.indexOf("ipcMain.handle('tins:"),
          restAfterChannel.indexOf("guardedHandle('tins:"),
        ].filter(i => i > 0),
        restAfterChannel.length,
      )
      const handlerSection = restAfterChannel.slice(0, nextHandleIdx)
      expect(handlerSection).toContain('this.disposed')
    })
  }

  it('guardedHandle 注册覆盖所有 tins:* handler，且每个 handler 均含 disposed 早返回', () => {
    const guardedRegistrations = (registerBody.match(/guardedHandle\('tins:/g) || []).length
    const disposedGuards = (registerBody.match(/if \(this\.disposed\) return/g) || []).length
    expect(guardedRegistrations).toBeGreaterThanOrEqual(channels.length)
    expect(disposedGuards).toBeGreaterThanOrEqual(channels.length)
  })
})
