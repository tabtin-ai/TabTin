import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: () => null,
}))

import { PtyManager } from '../PtyManager'
import { SubprocessPtyHostClient } from '../SubprocessPtyHost'

const builtHostProcessPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../out/main/pty-host-process.mjs',
)
const canRunSmoke = existsSync(builtHostProcessPath) && existsSync('/bin/cat')

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

class MockProcessTerminator {
  terminateTree = vi.fn()
}

describe('PtyManager subprocess smoke', () => {
  const originalShell = process.env.SHELL
  let processTerminator: MockProcessTerminator
  let manager: PtyManager

  beforeEach(() => {
    processTerminator = new MockProcessTerminator()
    manager = new PtyManager(
      new SubprocessPtyHostClient({ scriptPath: builtHostProcessPath }),
      processTerminator as any,
    )
    process.env.SHELL = '/bin/cat'
  })

  afterEach(() => {
    manager.cleanup()
    if (originalShell == null) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  })

  it.runIf(canRunSmoke)('在真实 subprocess host 下通过 readOutput 恢复输出，并用 shell pid 执行 kill tree', async () => {
    const dataSpy = vi.fn()
    manager.on('data', dataSpy)

    expect(manager.spawn('session-subprocess', { cwd: '/tmp' })).toBe(true)

    const initialPid = manager.getSession('session-subprocess')?.pid ?? 0
    expect(initialPid).toBeGreaterThan(0)

    expect(manager.write('session-subprocess', 'manager-subprocess\n')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(dataSpy).not.toHaveBeenCalled()

    manager.getSessionOutput('session-subprocess', { tail: 256 })

    const output = await waitFor(() => {
      const result = manager.getSessionOutput('session-subprocess', { tail: 256 })
      return result?.output.includes('manager-subprocess') ? result : false
    }, { timeoutMs: 10_000, intervalMs: 50 })

    const spawnedPid = await waitFor(() => {
      const pid = manager.getSession('session-subprocess')?.pid ?? 0
      return pid > 0 && pid !== initialPid ? pid : false
    }, { timeoutMs: 10_000, intervalMs: 50 })

    expect(output.metadata.pid).toBe(spawnedPid)

    expect(manager.kill('session-subprocess')).toBe(true)
    await waitFor(
      () => (processTerminator.terminateTree.mock.calls.length > 0
        ? processTerminator.terminateTree.mock.calls[0]
        : false),
      { timeoutMs: 10_000, intervalMs: 50 },
    )

    expect(processTerminator.terminateTree).toHaveBeenCalledWith(
      spawnedPid,
      expect.objectContaining({
        gracefulSignal: 'SIGTERM',
        forceSignal: 'SIGKILL',
      }),
    )
  }, 15_000)
})
