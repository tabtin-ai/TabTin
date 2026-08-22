/**
 * Regression tests for W5-F4 execution framework P2 fixes.
 *
 * EF-10: run_id must be passed to adapter.executeAction
 * EF-14: globalThis.tabtin injection must use Object.assign (no overwrite)
 * EF-15: FrontendActionBridge must not register tabcodeGitTools (duplicate)
 * EF-16: tabcode _meta must declare headless: true
 * EF-22: adapter tool execution must have a timeout guard
 * EF-24: DaemonActionBridge.dispose() must await destroyAllCheckpointServices
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { DaemonActionBridge } from '../src/application/execution/action-bridge.js'
import { createActionExecutionTestPorts } from './helpers/action-execution-ports.js'

// ────────────────────────────────────────────────────────────
// EF-10: run_id passed to adapter.executeAction
// ────────────────────────────────────────────────────────────

describe('EF-10 — run_id forwarded to adapter', () => {
  const bridgeSource = fs.readFileSync(
    path.resolve(__dirname, '../src/application/execution/action-bridge.ts'),
    'utf-8',
  )

  it('adapter.executeAction call includes run_id: traceId', () => {
    const adapterCallMatch = bridgeSource.match(
      /this\.adapter\.executeAction\(\{[\s\S]*?\}\)/,
    )
    expect(adapterCallMatch).not.toBeNull()
    expect(adapterCallMatch![0]).toContain('run_id: traceId')
  })
})

// ────────────────────────────────────────────────────────────
// EF-14: globalThis.tabtin merge instead of overwrite
// ────────────────────────────────────────────────────────────

describe('EF-14 — globalThis.tabtin uses Object.assign', () => {
  const daemonSource = fs.readFileSync(
    path.resolve(__dirname, '../src/bootstrap/daemon.ts'),
    'utf-8',
  )

  it('injectGlobalTabtin uses Object.assign with ??= pattern', () => {
    const methodStart = daemonSource.indexOf('private injectGlobalTabtin')
    expect(methodStart).toBeGreaterThan(-1)
    const methodBody = daemonSource.slice(
      methodStart,
      daemonSource.indexOf('\n  }', methodStart) + 4,
    )
    expect(methodBody).toContain('Object.assign')
    expect(methodBody).toContain('??=')
  })

  it('does NOT directly assign globalThis.tabtin =', () => {
    const methodStart = daemonSource.indexOf('private injectGlobalTabtin')
    const methodBody = daemonSource.slice(
      methodStart,
      daemonSource.indexOf('\n  }', methodStart) + 4,
    )
    expect(methodBody).not.toMatch(/globalThis\.tabtin\s*=\s*tabtin/)
  })
})

// ────────────────────────────────────────────────────────────
// EF-15: FrontendActionBridge does not register tabcodeGitTools
// ────────────────────────────────────────────────────────────

describe('EF-15 — no duplicate git tool registration in Electron', () => {
  const frontendBridgePath = path.resolve(
    __dirname,
    '../../tabtin-electron/src/main/services/FrontendActionBridge.ts',
  )

  it('FrontendActionBridge source exists', () => {
    expect(fs.existsSync(frontendBridgePath)).toBe(true)
  })

  it('does not call adapter.registerTools(tabcodeGitTools)', () => {
    const source = fs.readFileSync(frontendBridgePath, 'utf-8')
    expect(source).not.toMatch(/registerTools\(tabcodeGitTools\)/)
  })

  it('does not import tabcodeGitTools', () => {
    const source = fs.readFileSync(frontendBridgePath, 'utf-8')
    expect(source).not.toContain('tabcodeGitTools')
  })

  it('delegates tool registration to registerAllTools()', () => {
    const source = fs.readFileSync(frontendBridgePath, 'utf-8')
    expect(source).toContain('registerAllTools(this.adapter)')
  })
})

// ────────────────────────────────────────────────────────────
// EF-16: tabcode _meta.ts sets headless: true
// ────────────────────────────────────────────────────────────

describe('EF-16 — tabcode domain declares headless: true', () => {
  it('_meta.ts includes headless: true in domain.meta', () => {
    const metaPath = path.resolve(
      __dirname,
      '../../../packages/action-tools/src/tools/tabcode/_meta.ts',
    )
    const source = fs.readFileSync(metaPath, 'utf-8')
    expect(source).toMatch(/headless:\s*true/)
  })

  it('tabcode domain is included in headless domains', async () => {
    const { getHeadlessDomains } = await import(
      '../../../packages/action-tools/src/tools/index'
    )
    const domains = getHeadlessDomains()
    const tabcodeDomain = domains.find(
      (d: any) => d.meta.appId === 'tabcode',
    )
    expect(tabcodeDomain).toBeDefined()
    expect(tabcodeDomain!.meta.headless).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// EF-22: adapter tool execution has timeout guard
// ────────────────────────────────────────────────────────────

describe('EF-22 — tool execution timeout guard', () => {
  const bridgeSource = fs.readFileSync(
    path.resolve(__dirname, '../src/application/execution/action-bridge.ts'),
    'utf-8',
  )

  it('defines TOOL_EXECUTION_TIMEOUT_MS constant', () => {
    expect(bridgeSource).toMatch(/TOOL_EXECUTION_TIMEOUT_MS\s*=\s*300[_]?000/)
  })

  it('wraps adapter.executeAction with Promise.race', () => {
    expect(bridgeSource).toContain('Promise.race')
  })

  it('returns tool_timeout error code on timeout', () => {
    expect(bridgeSource).toContain("error_code: 'tool_timeout'")
  })
})

// ────────────────────────────────────────────────────────────
// EF-24: dispose() is async and awaits destroyAllCheckpointServices
// ────────────────────────────────────────────────────────────

describe('EF-24 — dispose() awaits checkpoint cleanup', () => {
  it('awaits cleanup through the workspace history port', async () => {
    const ports = createActionExecutionTestPorts()
    const disposeCheckpoints = vi.fn(async () => {})
    ports.workspaceHistory.checkpoints.dispose = disposeCheckpoints
    const bridge = new DaemonActionBridge(
      { workspace_root: '/workspace' } as any,
      { getPlugins: () => [], setOnPluginLoaded: () => {} },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      ports,
    )

    await bridge.dispose()

    expect(disposeCheckpoints).toHaveBeenCalledOnce()
  })
})
