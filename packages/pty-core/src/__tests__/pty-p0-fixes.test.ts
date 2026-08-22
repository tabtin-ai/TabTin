import { describe, it, expect } from 'vitest'
import type { PendingCommand, ExecuteCommandResult } from '../PtySessionStore'
import { wrapCommand } from '../marker/command-wrapper'
import type { MarkerPair } from '../marker/generator'

function makeMarkers(): MarkerPair {
  return {
    nonce: 'abc123def456abc123def456abc12345',
    startMarker: '__TABTIN_CMD_START_abc123def456abc123def456abc12345__',
    endMarkerPrefix: '__TABTIN_CMD_END_abc123def456abc123def456abc12345_',
  }
}

describe('PTY-001: markerScanCursor is optional on PendingCommand', () => {
  it('should allow creating PendingCommand without markerScanCursor', () => {
    const pending: PendingCommand = {
      nonce: 'test',
      startMarker: 'start',
      endMarkerPrefix: 'end',
      startedAt: Date.now(),
      bufferStartCursor: 0,
      resolve: (_result: ExecuteCommandResult) => {},
      timer: null,
      sessionId: 'test-session',
    }
    expect(pending.markerScanCursor).toBeUndefined()
  })

  it('should allow creating PendingCommand with markerScanCursor', () => {
    const cursor = 42
    const pending: PendingCommand = {
      nonce: 'test',
      startMarker: 'start',
      endMarkerPrefix: 'end',
      startedAt: Date.now(),
      bufferStartCursor: 0,
      markerScanCursor: cursor,
      resolve: (_result: ExecuteCommandResult) => {},
      timer: null,
      sessionId: 'test-session',
    }
    expect(pending.markerScanCursor).toBe(cursor)
  })
})

describe('PTY-002: wrapCommand merges context env and workingDirectory', () => {
  it('should include env vars from options.env', () => {
    const markers = makeMarkers()
    const result = wrapCommand('echo hello', markers, {
      env: { MY_VAR: 'value1' },
    })
    expect(result).toContain("export MY_VAR='value1'")
  })

  it('should include workingDirectory from options', () => {
    const markers = makeMarkers()
    const result = wrapCommand('echo hello', markers, {
      workingDirectory: '/tmp/test',
    })
    expect(result).toContain("cd '/tmp/test'")
  })

  it('should include both context.env and options.env when merged by caller', () => {
    const markers = makeMarkers()
    const contextEnv = { CTX_VAR: 'from_context' }
    const optionsEnv = { OPT_VAR: 'from_options' }
    const mergedEnv = { ...contextEnv, ...optionsEnv }

    const result = wrapCommand('echo hello', markers, { env: mergedEnv })

    expect(result).toContain("export CTX_VAR='from_context'")
    expect(result).toContain("export OPT_VAR='from_options'")
  })

  it('should let options.env override context.env for the same key', () => {
    const markers = makeMarkers()
    const contextEnv = { SHARED_KEY: 'context_val' }
    const optionsEnv = { SHARED_KEY: 'options_val' }
    const mergedEnv = { ...contextEnv, ...optionsEnv }

    const result = wrapCommand('echo hello', markers, { env: mergedEnv })

    expect(result).toContain("export SHARED_KEY='options_val'")
    expect(result).not.toContain('context_val')
  })

  it('should use options.workingDirectory over context.workingDirectory when both present', () => {
    const markers = makeMarkers()
    const effectiveWd = '/from/options'
    const result = wrapCommand('echo hello', markers, {
      workingDirectory: effectiveWd,
    })
    expect(result).toContain("cd '/from/options'")
  })

  it('should fall back to context.workingDirectory when options.workingDirectory is absent', () => {
    const markers = makeMarkers()
    const contextWd = '/from/context'
    const result = wrapCommand('echo hello', markers, {
      workingDirectory: contextWd,
    })
    expect(result).toContain("cd '/from/context'")
  })

  it('should produce correct command without env or workingDirectory', () => {
    const markers = makeMarkers()
    const result = wrapCommand('ls -la', markers)

    expect(result).toContain('ls -la')
    expect(result).toContain(markers.startMarker)
    expect(result).toContain(markers.endMarkerPrefix)
    expect(result).not.toContain('export')
    expect(result).not.toContain('cd ')
  })
})
