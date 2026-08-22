import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const source = (relativePath: string): string => readFileSync(
  join(sourceRoot, relativePath),
  'utf8',
)

const repoSource = (relativePath: string): string => readFileSync(
  join(repoRoot, relativePath),
  'utf8',
)

describe('Django IM process boundary', () => {
  it('keeps Renderer on the Django IM provider', () => {
    const rendererRuntime = source('renderer/src/services/tabchatApi.ts')
    expect(rendererRuntime).toContain('createDjangoIMProvider')
    expect(rendererRuntime).not.toContain('createTencentRemoteIMProvider()')
    expect(rendererRuntime).not.toContain('@tencentcloud/lite-chat')
  })

  it('does not register the Tencent main-process data plane', () => {
    const ipcRegistry = source('main/ipc-registry.ts')
    expect(ipcRegistry).not.toMatch(/^\s*registerIMDataPlaneBroker\(/m)
  })

  it('does not restore the standalone IM service token or callback ingress', () => {
    const settings = repoSource('apps/tabtin_django/tabtin/settings.py')
    const notificationApi = repoSource(
      'apps/tabtin_django/apps/services/notification/api.py',
    )
    expect(settings).not.toContain('IM_INTERNAL_SERVICE_TOKEN')
    expect(notificationApi).not.toContain('/internal/im-message')
    expect(notificationApi).not.toContain('X-TabTin-IM-Service-Token')
  })
})
