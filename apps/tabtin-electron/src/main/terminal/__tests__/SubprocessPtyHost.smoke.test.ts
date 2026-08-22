import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PtyHostExitEvent } from '../PtyHost'
import { SubprocessPtyHostClient } from '../SubprocessPtyHost'

const builtHostProcessPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../out/main/pty-host-process.mjs',
)
const canRunCatSmoke = existsSync(builtHostProcessPath) && existsSync('/bin/cat')
const canRunShellSmoke = existsSync(builtHostProcessPath) && existsSync('/bin/sh')

async function waitFor<T>(
  probe: () => T | false | null | undefined,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 25
  const start = Date.now()

  while (Date.now() - start <= timeoutMs) {
    const result = probe()
    if (result !== false && result != null) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`waitFor timeout after ${timeoutMs}ms`)
}

async function waitForPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`waitForPromise timeout after ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

describe('SubprocessPtyHostClient smoke', () => {
  it.runIf(canRunCatSmoke)('通过真实 pty-host-process 产物完成 pause/resume 与 kill/exit', async () => {
    const hostClient = new SubprocessPtyHostClient({
      scriptPath: builtHostProcessPath,
    })
    const session = hostClient.spawn({
      shell: '/bin/cat',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' },
      termName: 'xterm-256color',
    })

    let spawnedPid = 0
    let output = ''
    let exitResolved = false

    session.onSpawned(({ pid }) => {
      spawnedPid = pid
    })
    session.onData((data) => {
      output += data
    })

    const exitPromise = new Promise<PtyHostExitEvent>((resolve) => {
      session.onExit((event) => {
        exitResolved = true
        resolve(event)
      })
    })

    try {
      session.pauseOutput()
      session.write('subprocess-smoke\n')

      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(output).not.toContain('subprocess-smoke')

      session.resumeOutput()

      await waitFor(() => output.includes('subprocess-smoke') ? output : false)
      const pid = await waitFor(() => (spawnedPid > 0 ? spawnedPid : false))

      expect(session.pid).toBe(pid)

      session.kill('SIGTERM')
      const exitEvent = await waitForPromise(exitPromise, 5_000)

      expect(exitEvent.exitCode !== null || exitEvent.signal != null).toBe(true)
    } finally {
      if (!exitResolved) {
        session.kill('SIGKILL')
        try {
          await waitForPromise(exitPromise, 2_000)
        } catch {
          // ignore best-effort cleanup failure in smoke test teardown
        }
      }
    }
  })

  it.runIf(canRunShellSmoke)('在 paused 状态下遇到大输出时仍能在恢复后完整冲刷关键标记', async () => {
    const hostClient = new SubprocessPtyHostClient({
      scriptPath: builtHostProcessPath,
    })
    const session = hostClient.spawn({
      shell: '/bin/sh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' },
      termName: 'xterm-256color',
    })

    const largeOutputScript = [
      'process.stdout.write("__TABTIN_BP_START__\\n")',
      'for (let index = 0; index < 48; index += 1) {',
      '  process.stdout.write(`chunk-${index}-${"x".repeat(3072)}\\n`)',
      '}',
      'process.stdout.write("__TABTIN_BP_END__\\n")',
    ].join('; ')
    const largeOutputCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(largeOutputScript)}\nexit\n`
    let output = ''
    let exitResolved = false

    session.onData((data) => {
      output += data
    })
    const exitPromise = new Promise<PtyHostExitEvent>((resolve) => {
      session.onExit((event) => {
        exitResolved = true
        resolve(event)
      })
    })

    try {
      session.pauseOutput()
      session.write(largeOutputCommand)

      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(output).not.toContain('__TABTIN_BP_END__')

      session.resumeOutput()

      await waitFor(() => {
        return output.includes('__TABTIN_BP_START__') && output.includes('__TABTIN_BP_END__')
          ? output
          : false
      }, { timeoutMs: 10_000, intervalMs: 50 })

      const exitEvent = await waitForPromise(exitPromise, 5_000)
      expect(exitEvent.exitCode !== null || exitEvent.signal != null).toBe(true)
    } finally {
      if (!exitResolved) {
        session.kill('SIGKILL')
        try {
          await waitForPromise(exitPromise, 2_000)
        } catch {
          // ignore best-effort cleanup failure in smoke test teardown
        }
      }
    }
  }, 15_000)
})
