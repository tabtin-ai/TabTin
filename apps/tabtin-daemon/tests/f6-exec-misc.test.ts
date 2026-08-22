/**
 * Regression tests for F6 exec-misc fixes.
 *
 * BR-01: DaemonBrowserService.setWorkspaceRoot must be called in daemon.ts
 *        so that validateSavePath accepts workspace-relative paths.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { validateSavePath } from '../src/platform/browser/DaemonBrowserService.js'

// ── BR-01: setWorkspaceRoot called in daemon.ts initBrowserService ──

describe('BR-01 — BrowserRuntime owns workspace setup', () => {
  const daemonSourcePath = path.resolve(__dirname, '../src/platform/browser/browser-runtime.ts')

  it('start configures the workspace before claiming the runtime publication', () => {
    const source = fs.readFileSync(daemonSourcePath, 'utf-8')
    const startIdx = source.indexOf('async start()')
    expect(startIdx).toBeGreaterThan(-1)
    const body = source.slice(startIdx, source.indexOf('\n  }', startIdx) + 4)
    expect(body).toContain('setWorkspaceRoot')
    const setWorkspaceIdx = body.indexOf('setWorkspaceRoot')
    const claimRuntimeIdx = body.indexOf('claimBrowserAdapters(this)')
    expect(claimRuntimeIdx).toBeGreaterThan(-1)
    expect(setWorkspaceIdx).toBeLessThan(claimRuntimeIdx)
  })

  it('validateSavePath accepts workspace paths when workspaceRoot is set', () => {
    const workspaceRoot = '/home/testuser/my-project'
    const savePath = '/home/testuser/my-project/output/screenshot.png'
    expect(() => validateSavePath(savePath, workspaceRoot)).not.toThrow()
  })

  it('validateSavePath rejects workspace paths when workspaceRoot is not set', () => {
    const savePath = '/home/testuser/my-project/output/screenshot.png'
    expect(() => validateSavePath(savePath)).toThrow()
  })
})
