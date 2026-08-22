import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const daemonRoot = resolve(import.meta.dirname, '..')

function readSource(path: string): string {
  return readFileSync(resolve(daemonRoot, path), 'utf8')
}

describe('browser application atomic cutover', () => {
  it('keeps daemon orchestrator hooks out of the CLI transport', () => {
    const route = readSource('src/transport/cli/routes/browser/index.ts')

    expect(route).not.toContain('daemonExecHooks')
    expect(route).not.toContain('daemonSessionHooks')
    expect(route).not.toContain('daemonResourceStreamHooks')
    expect(route).not.toContain('daemonJobHooks')
    expect(route).not.toContain('daemonHostHooks')
    expect(route).not.toContain('DaemonBrowserService')
    expect(route).not.toContain('useBrowserIfReady')
    expect(route).not.toMatch(/from ['"].*platform\/browser/)
  })

  it('keeps HTTP protocol concerns out of the browser application module', () => {
    const application = readSource('src/platform/browser/DaemonBrowserApplication.ts')

    expect(application).toContain('class DaemonBrowserApplication')
    expect(application).not.toMatch(/from ['"].*transport\//)
    expect(application).not.toContain('ServerResponse')
    expect(application).not.toContain('SendJSON')
    expect(application).not.toContain('handleBrowserRoute')
  })
})
