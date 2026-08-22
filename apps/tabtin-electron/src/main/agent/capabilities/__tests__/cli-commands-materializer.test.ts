/**
 * cli-commands-materializer 单测（ C1 /  常驻）
 *
 * 覆盖：一次 spawn 派生 listing（剔 hidden）+ schemas（含 hidden）；
 * 常驻命中不重复 spawn；invalidate 后重 spawn；在飞合并；失败不写空成功。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { CatalogStore } from '@tabtin/agent-host/state'
import { createTabtinReadonlyChecker } from '@tabtin/agent-runtime/capability'
import {
  __resetCliCommandsMaterializerForTesting,
  __setCliCommandsExecForTesting,
  bindCatalogStore,
  completeCliRiskSchemas,
  ensureCliCommandsMaterialized,
  getCliCommandsMaterializedSnapshot,
  invalidateCliCommandsMaterialized,
  unbindCatalogStoreForTests,
  warmCliCommandsMaterialized,
} from '../cli-commands-materializer'
import { createCliListingFetcher } from '../cli-listing-fetcher'

function envelope(commands: Array<Record<string, unknown>>): string {
  return JSON.stringify({ ok: true, data: { commands } })
}

const execFileAsync = vi.fn()
let catalog: CatalogStore

beforeEach(() => {
  catalog = new CatalogStore()
  bindCatalogStore(() => catalog)
  __resetCliCommandsMaterializerForTesting()
  execFileAsync.mockReset()
  __setCliCommandsExecForTesting(execFileAsync)
})

afterEach(() => {
  __resetCliCommandsMaterializerForTesting()
  unbindCatalogStoreForTests()
})

describe('cli-commands-materializer（ C1）', () => {
  it('一次 spawn：listing 剔 hidden，schemas 保留全量', async () => {
    execFileAsync.mockResolvedValue({
      stdout: envelope([
        { name: 'doc read', description: 'read', risk: 'read' },
        { name: 'memo list', description: 'memo', risk: 'read', hidden: true },
      ]),
    })

    const materialized = await ensureCliCommandsMaterialized()

    expect(execFileAsync).toHaveBeenCalledTimes(1)
    expect(execFileAsync.mock.calls[0]?.[0]).toBe('tabtin')
    expect(execFileAsync.mock.calls[0]?.[1]).toEqual([
      'commands',
      '--format',
      'json',
      '--include-hidden',
    ])
    expect(materialized?.listing.commands.map((c) => c.name)).toEqual(['doc read'])
    expect(materialized?.schemas.map((c) => c.name)).toEqual(['doc read', 'memo list'])
    expect(materialized?.riskSchemasComplete).toBe(true)
  })

  it('常驻缓存第二次调用命中，不重复 spawn（时间推移亦不失效）', async () => {
    const now = Date.now()
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    execFileAsync.mockResolvedValue({
      stdout: envelope([{ name: 'files list', risk: 'read' }]),
    })

    await ensureCliCommandsMaterialized()
    dateSpy.mockReturnValue(now + 31 * 60 * 1000)
    await ensureCliCommandsMaterialized()

    expect(execFileAsync).toHaveBeenCalledTimes(1)
    dateSpy.mockRestore()
  })

  it('Host 初始化 warm 使用长预算，热路径快照读取不 spawn', async () => {
    execFileAsync.mockResolvedValue({
      stdout: envelope([{ name: 'files list', risk: 'read' }]),
    })

    const materialized = await warmCliCommandsMaterialized('host-start')

    expect(execFileAsync).toHaveBeenCalledTimes(1)
    expect(execFileAsync.mock.calls[0]?.[2]?.timeout).toBe(30_000)
    expect(materialized?.listing.commands[0]?.name).toBe('files list')
    expect(getCliCommandsMaterializedSnapshot()).toBe(materialized)
    expect(execFileAsync).toHaveBeenCalledTimes(1)
  })

  it('发送热路径缺快照时本轮返回 null，并后台触发 warm', async () => {
    let release!: (value: { stdout: string }) => void
    execFileAsync.mockReturnValue(
      new Promise<{ stdout: string }>((resolve) => {
        release = resolve
      }),
    )
    const fetchCli = createCliListingFetcher()

    await expect(fetchCli({})).resolves.toBeNull()

    expect(execFileAsync).toHaveBeenCalledTimes(1)
    expect(execFileAsync.mock.calls[0]?.[2]?.timeout).toBe(30_000)

    release({ stdout: envelope([{ name: 'files list', risk: 'read' }]) })
    const materialized = await warmCliCommandsMaterialized('test-join-background-warm')
    expect(materialized?.listing.commands.map((command) => command.name)).toEqual(['files list'])
    expect(execFileAsync).toHaveBeenCalledTimes(1)
  })

  it('发送热路径命中快照时返回 listing，不再 spawn', async () => {
    execFileAsync.mockResolvedValue({
      stdout: envelope([{ name: 'files list', risk: 'read' }]),
    })
    await warmCliCommandsMaterialized('host-start')
    execFileAsync.mockClear()

    const fetchCli = createCliListingFetcher()

    const listing = await fetchCli({})

    expect(listing?.commands.map((command) => command.name)).toEqual(['files list'])
    expect(execFileAsync).not.toHaveBeenCalled()
  })

  it('在飞请求合并为单次 spawn', async () => {
    let release!: (value: { stdout: string }) => void
    execFileAsync.mockReturnValue(
      new Promise<{ stdout: string }>((resolve) => {
        release = resolve
      }),
    )

    const p1 = ensureCliCommandsMaterialized()
    const p2 = ensureCliCommandsMaterialized()
    release({ stdout: envelope([{ name: 'browser open', risk: 'write' }]) })
    const [a, b] = await Promise.all([p1, p2])

    expect(execFileAsync).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a?.listing.commands[0]?.name).toBe('browser open')
  })

  it('spawn 失败且无旧缓存时返回 null（不写空成功）', async () => {
    execFileAsync.mockRejectedValue(new Error('ENOENT'))

    await expect(ensureCliCommandsMaterialized()).resolves.toBeNull()
  })

  it('旧 CLI 不认识 --include-hidden 时回退可见目录，不让 Agent 丢失全部 CLI 能力', async () => {
    execFileAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed with exit code 2'), {
          stderr: 'Error: unknown flag: --include-hidden',
        }),
      )
      .mockResolvedValueOnce({
        stdout: envelope([{ name: 'doc read', description: 'read', risk: 'read' }]),
      })

    const materialized = await ensureCliCommandsMaterialized()

    expect(execFileAsync).toHaveBeenCalledTimes(2)
    expect(execFileAsync.mock.calls[1]?.[1]).toEqual(['commands', '--format', 'json'])
    expect(materialized?.listing.commands.map((command) => command.name)).toEqual(['doc read'])
    expect(materialized?.schemas).toEqual([])
    expect(materialized?.riskSchemasComplete).toBe(false)
    expect(completeCliRiskSchemas(materialized)).toBeNull()

    const checker = createTabtinReadonlyChecker({
      fetchCommandRisk: async () => {
        if (!completeCliRiskSchemas(materialized)) throw new Error('incomplete risk catalog')
        return null
      },
      readonlyVerbs: new Set(['export']),
    })
    const decision = await checker.isAllowed('tabtin hidden-domain export')
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe('lookup_failed')
  })

  it('parse 失败且无旧缓存时返回 null', async () => {
    execFileAsync.mockResolvedValue({ stdout: 'not-json{' })

    await expect(ensureCliCommandsMaterialized()).resolves.toBeNull()
  })

  it('invalidate 后重新 spawn；spawn 失败时回落旧缓存', async () => {
    execFileAsync.mockResolvedValueOnce({
      stdout: envelope([{ name: 'doc read', risk: 'read' }]),
    })
    const first = await ensureCliCommandsMaterialized()
    expect(first?.listing.commands[0]?.name).toBe('doc read')

    invalidateCliCommandsMaterialized()
    execFileAsync.mockRejectedValueOnce(new Error('boom'))
    const stale = await ensureCliCommandsMaterialized()
    expect(stale?.listing.commands[0]?.name).toBe('doc read')
    expect(execFileAsync).toHaveBeenCalledTimes(2)
  })
})
