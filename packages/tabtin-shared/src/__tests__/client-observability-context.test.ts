import { describe, expect, it } from 'vitest'
import { buildSafeSentryContext } from '../client-observability-context'

describe('buildSafeSentryContext', () => {
  it('separates low-cardinality tags from correlation context and keeps only user ID', () => {
    const result = buildSafeSentryContext({
      source: 'client',
      service: 'tabtin-client',
      clientPlatform: 'desktop',
      runtime: 'electron-renderer',
      environment: 'preprod',
      release: 'tabtin-electron@1.0.72',
      errorCategory: 'STARTUP_FATAL',
      errorCode: 'BOOTSTRAP_FAILED',
      severity: 'fatal',
      handledBy: 'renderer_bootstrap',
      recoverability: 'unrecoverable',
      userId: 'user-1',
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      clientInstallId: 'install-1',
      appVersion: '1.0.72',
      buildNumber: '202608071530',
      gitSha: 'abcdef1234567890',
      platform: 'desktop',
    })

    expect(result.tags).toEqual({
      source: 'client',
      service: 'tabtin-client',
      client_platform: 'desktop',
      runtime: 'electron-renderer',
      environment: 'preprod',
      release: 'tabtin-electron@1.0.72',
      error_category: 'STARTUP_FATAL',
      error_code: 'BOOTSTRAP_FAILED',
      severity: 'fatal',
      handled_by: 'renderer_bootstrap',
      recoverability: 'unrecoverable',
    })
    expect(result.contexts.tabtin).toEqual({
      organization_id: 'org-1',
      workspace_id: 'workspace-1',
      run_id: 'run-1',
      client_install_id: 'install-1',
      app_version: '1.0.72',
      build_number: '202608071530',
      git_sha: 'abcdef1234567890',
      platform: 'desktop',
    })
    expect(result.user).toEqual({ id: 'user-1' })
    expect(result).not.toHaveProperty('recoverability')
  })
})
