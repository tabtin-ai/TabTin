/**
 * Regression tests for action-bridge.ts fixes:
 *
 * EF-05 (P1): _space_id / _agent_space_id injection fallback when backend
 *             payload has these fields inside params (not at envelope top level).
 * BR-02 (P1): tabNavigationTools / tabManagementTools registered to adapter
 *             when DaemonBrowserService is available.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ACTION_BRIDGE_PATH = path.resolve(__dirname, '../src/application/execution/action-bridge.ts')
const HEADLESS_IMPORT_PATH = path.resolve(__dirname, '../../../packages/action-tools/src/headless.ts')
const DAEMON_PATH = path.resolve(__dirname, '../src/bootstrap/daemon.ts')

// ---------------------------------------------------------------------------
// EF-05: _space_id / _agent_space_id fallback from params
// ---------------------------------------------------------------------------
describe('EF-05 — _space_id injection fallback', () => {
  const source = fs.readFileSync(ACTION_BRIDGE_PATH, 'utf-8')

  it('contains fallback for _space_id from params.space_id', () => {
    expect(source).toContain('params._space_id = params.space_id')
  })

  it('contains fallback for _space_id from params.agent_space_id', () => {
    expect(source).toContain('params.space_id ?? params.agent_space_id')
  })

  it('contains fallback for _agent_space_id from params.agent_space_id', () => {
    expect(source).toContain('params._agent_space_id = params.agent_space_id')
  })

  it('contains fallback for _agent_space_id from params.space_id', () => {
    expect(source).toContain('params.agent_space_id ?? params.space_id')
  })

  it('fallback guards are preceded by !params._space_id / !params._agent_space_id', () => {
    expect(source).toContain('if (!params._space_id)')
    expect(source).toContain('if (!params._agent_space_id)')
  })

  it('fallback appears AFTER envelope-level injection (not before)', () => {
    const envelopeInjectionIdx = source.indexOf('this.injectBaseActionContext(params, payload')
    const fallbackIdx = source.indexOf("params._space_id = params.space_id")
    expect(envelopeInjectionIdx).toBeGreaterThan(-1)
    expect(fallbackIdx).toBeGreaterThan(-1)
    expect(fallbackIdx).toBeGreaterThan(envelopeInjectionIdx)
  })
})

describe('EF-05 — simulated param injection logic', () => {
  function simulateInjection(payload: Record<string, any>, rawParams: Record<string, any>) {
    const params = { ...rawParams }

    if (typeof payload.agent_space_id === 'string' && payload.agent_space_id) {
      params._agent_space_id = payload.agent_space_id
    }
    if (typeof payload.space_id === 'string' && payload.space_id) {
      params._space_id = payload.space_id
    }

    // EF-05 fallback
    if (!params._space_id) {
      params._space_id = params.space_id ?? params.agent_space_id
    }
    if (!params._agent_space_id) {
      params._agent_space_id = params.agent_space_id ?? params.space_id
    }

    return params
  }

  it('injects from params.space_id when payload has no top-level space_id', () => {
    const result = simulateInjection(
      { task_id: 't1', action: 'file_read' },
      { space_id: 'sp-123', file_path: '/test' },
    )
    expect(result._space_id).toBe('sp-123')
  })

  it('injects from params.agent_space_id when payload has no top-level fields', () => {
    const result = simulateInjection(
      { task_id: 't1', action: 'file_read' },
      { agent_space_id: 'asp-456', file_path: '/test' },
    )
    expect(result._space_id).toBe('asp-456')
    expect(result._agent_space_id).toBe('asp-456')
  })

  it('prefers payload top-level space_id over params.space_id', () => {
    const result = simulateInjection(
      { task_id: 't1', action: 'file_read', space_id: 'top-level' },
      { space_id: 'in-params', file_path: '/test' },
    )
    expect(result._space_id).toBe('top-level')
  })

  it('handles both space_id and agent_space_id in params', () => {
    const result = simulateInjection(
      { task_id: 't1', action: 'file_read' },
      { space_id: 'sp-a', agent_space_id: 'asp-b' },
    )
    expect(result._space_id).toBe('sp-a')
    expect(result._agent_space_id).toBe('asp-b')
  })

  it('falls back cross-field when only one is present', () => {
    const result = simulateInjection(
      { task_id: 't1', action: 'file_read' },
      { space_id: 'sp-only' },
    )
    expect(result._space_id).toBe('sp-only')
    expect(result._agent_space_id).toBe('sp-only')
  })

  it('returns undefined fields when nothing is provided', () => {
    const result = simulateInjection(
      { task_id: 't1', action: 'file_read' },
      { file_path: '/test' },
    )
    expect(result._space_id).toBeUndefined()
    expect(result._agent_space_id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BR-02: tabNavigationTools / tabManagementTools registration
// ---------------------------------------------------------------------------
describe('BR-02 — headless.ts exports browser tool groups', () => {
  const headlessSource = fs.readFileSync(HEADLESS_IMPORT_PATH, 'utf-8')

  it('exports tabNavigationTools', () => {
    expect(headlessSource).toMatch(/export\s*\{[^}]*tabNavigationTools[^}]*\}/)
  })

  it('exports tabManagementTools', () => {
    expect(headlessSource).toMatch(/export\s*\{[^}]*tabManagementTools[^}]*\}/)
  })

  it('createHeadlessAdapter includes browser tools when browser capability is present', async () => {
    const { createHeadlessAdapter } = await import('@tabtin/action-tools/headless')
    const adapter = createHeadlessAdapter({ capabilities: new Set(['terminal', 'file', 'browser']) })
    const tools = adapter.getRegisteredTools()
    expect(tools).toContain('open_tab')
    expect(tools).toContain('close_tab')
    expect(tools).toContain('get_tabs')
    expect(tools).toContain('load_tab_url')
  })
})

describe('BR-02 — daemon.ts initialization order', () => {
  const daemonSource = fs.readFileSync(DAEMON_PATH, 'utf-8')

  it('initBrowserService is called before registerCoreExecutors', () => {
    const browserInitIdx = daemonSource.indexOf('initBrowserService()')
    const registerIdx = daemonSource.indexOf('registerCoreExecutors()')
    expect(browserInitIdx).toBeGreaterThan(-1)
    expect(registerIdx).toBeGreaterThan(-1)
    expect(browserInitIdx).toBeLessThan(registerIdx)
  })
})
