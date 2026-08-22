import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildSafeSentryContext, type SafeSentryContextInput } from '../client-observability-context'

const schemaUrl = new URL('../client-observability-context.schema.json', import.meta.url)

function readSchema(): Record<string, any> {
  return JSON.parse(readFileSync(schemaUrl, 'utf8')) as Record<string, any>
}

describe('client observability context schema', () => {
  it('keeps correlation IDs in contexts.tabtin instead of searchable tags', () => {
    const schema = readSchema()
    const tagProperties = schema.$defs.tags.properties
    const tabtinProperties = schema.$defs.tabtinContext.properties

    for (const key of [
      'organization_id',
      'workspace_id',
      'space_id',
      'agent_id',
      'session_id',
      'run_id',
      'request_id',
      'task_id',
      'diagnostic_bundle_id',
      'client_install_id',
    ]) {
      expect(tagProperties).not.toHaveProperty(key)
      expect(tabtinProperties).toHaveProperty(key)
    }

    expect(schema.$defs.tags.additionalProperties).toBe(false)
    expect(schema.$defs.tabtinContext.additionalProperties).toBe(false)
    expect(schema.$defs.tabtinContext.properties.git_sha.pattern).toBe('^[0-9a-f]{7,40}$')
  })

  it('defines the fixed V1 error categories and recovery outcomes', () => {
    const schema = readSchema()

    expect(schema.$defs.errorCategory.enum).toEqual([
      'CLIENT_CRASH',
      'RENDERER_CRASH',
      'GPU_CRASH',
      'WEBVIEW_CRASH',
      'STARTUP_FATAL',
      'IPC_FATAL',
      'AGENT_RUN_FATAL',
      'AGENT_DOOM_LOOP',
      'AGENT_PROTOCOL_FATAL',
      'NETWORK_FATAL',
      'AUTH_FATAL',
      'LOCAL_DATA_FATAL',
      'RESOURCE_FATAL',
      'HANG',
      'ABNORMAL_TERMINATION',
      'UNKNOWN_FATAL',
    ])
    expect(schema.$defs.recoverability.enum).toEqual([
      'recovered',
      'degraded',
      'unrecoverable',
      'unknown',
    ])
    expect(schema.properties).not.toHaveProperty('recoverability')
    expect(schema.$defs.tags.properties.recoverability).toEqual({
      $ref: '#/$defs/recoverability',
    })
  })

  it('allows only the internal user ID in Sentry identity', () => {
    const schema = readSchema()

    expect(schema.$defs.user.required).toEqual(['id'])
    expect(Object.keys(schema.$defs.user.properties)).toEqual(['id'])
    expect(schema.$defs.user.additionalProperties).toBe(false)
  })

  it.each([
    ['desktop', 'electron-main'],
    ['ios', 'ios-native'],
    ['android', 'android-native'],
  ] as const)('matches a real %s scope fragment emitted by the shared builder', (clientPlatform, runtime) => {
    const schema = readSchema()
    const context = buildSafeSentryContext({
      source: 'client',
      service: 'tabtin-client',
      clientPlatform,
      runtime,
      environment: 'preprod',
      release: 'tabtin@1.0.0+1',
      errorCategory: 'CLIENT_CRASH',
      errorCode: 'UNCAUGHT_EXCEPTION',
      severity: 'crash',
      handledBy: 'sdk',
      recoverability: 'unrecoverable',
      organizationId: 'org-1',
      clientInstallId: 'install-1',
      userId: 'user-1',
    } satisfies SafeSentryContextInput)

    expect(Object.keys(context.tags).sort()).toEqual(
      [...schema.$defs.tags.required].sort(),
    )
    expect(Object.keys(context.tags).every((key) => key in schema.$defs.tags.properties)).toBe(true)
    expect(Object.keys(context.contexts.tabtin).every(
      (key) => key in schema.$defs.tabtinContext.properties,
    )).toBe(true)
    expect(context.tags.recoverability).toBe('unrecoverable')
    expect(context).not.toHaveProperty('recoverability')
  })
})
