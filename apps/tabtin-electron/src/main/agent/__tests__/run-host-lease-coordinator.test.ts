import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  FENCE_REASON_HELD,
  FENCE_REASON_LEASE_EXPIRED,
  FENCE_REASON_OWNERSHIP_TRANSFERRED,
  FENCE_REASON_PROJECTION_MISMATCH,
  RUN_HOST_HEARTBEAT_MAX_DELAY_MS,
  RUN_HOST_HEARTBEAT_MIN_DELAY_MS,
  RunHostLeaseCoordinator,
  type RunHostLeaseApi,
} from '../../../../../../packages/agent-host/src/state/lease/run-host-lease-coordinator'

function createHarness(random: () => number = () => 0.5) {
  let timeoutCallback: (() => void) | undefined
  const scheduledDelays: number[] = []
  const api: RunHostLeaseApi = {
    claim: vi.fn(async runId => ({
      outcome: 'claimed',
      run_id: runId,
      lease_token: `token-${runId}`,
      generation: 1,
    })),
    heartbeat: vi.fn(async runId => ({
      outcome: 'renewed',
      run_id: runId,
      lease_token: `token-${runId}`,
      generation: 1,
    })),
    reconcile: vi.fn(async () => ({
      runs: [],
      converged_run_ids: [],
    })),
  }
  const onFenced = vi.fn()
  const coordinator = new RunHostLeaseCoordinator(
    api,
    'electron:persistent-device-id',
    onFenced,
    { info: vi.fn(), warn: vi.fn() },
    {
      setTimeout: vi.fn((callback, delayMs) => {
        scheduledDelays.push(delayMs)
        expect(delayMs).toBeGreaterThanOrEqual(RUN_HOST_HEARTBEAT_MIN_DELAY_MS)
        expect(delayMs).toBeLessThanOrEqual(RUN_HOST_HEARTBEAT_MAX_DELAY_MS)
        timeoutCallback = callback
        return 7 as unknown as ReturnType<typeof setTimeout>
      }),
      clearTimeout: vi.fn(),
    },
    random,
  )
  return {
    api,
    coordinator,
    onFenced,
    scheduledDelays,
    fireInterval: () => timeoutCallback?.(),
    tick: async () => {
      timeoutCallback?.()
      await vi.waitFor(() => {
        expect(api.heartbeat).toHaveBeenCalled()
      })
    },
  }
}

describe('RunHostLeaseCoordinator', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('启动以持久 host id 和空 active 集合 reconcile', async () => {
    const { api, coordinator } = createHarness()

    await coordinator.start()

    expect(api.reconcile).toHaveBeenCalledWith(
      'electron:persistent-device-id',
      [],
    )
  })

  it('claim 后按 jitter heartbeat，终态 stopTracking 后停止续租', async () => {
    const { api, coordinator, fireInterval, tick } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-1')).toBe('claimed')

    await tick()
    expect(api.heartbeat).toHaveBeenCalledWith(
      'run-1',
      'electron:persistent-device-id',
      'token-run-1',
    )

    coordinator.stopTracking('run-1')
    vi.mocked(api.heartbeat).mockClear()
    // 没有 active lease 时 tick 直接返回，不触发 API。
    fireInterval()
    await Promise.resolve()
    expect(api.heartbeat).not.toHaveBeenCalled()
  })

  it('每轮 heartbeat 在 16–24 秒窗口内独立抖动', async () => {
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
    const { coordinator, fireInterval, scheduledDelays } = createHarness(random)
    await coordinator.start()
    fireInterval()
    await vi.waitFor(() => {
      expect(scheduledDelays).toHaveLength(2)
    })

    expect(scheduledDelays).toEqual([
      RUN_HOST_HEARTBEAT_MIN_DELAY_MS,
      RUN_HOST_HEARTBEAT_MAX_DELAY_MS,
    ])
  })

  it('同进程重复 forward 不重复 claim，不旋转当前 token', async () => {
    const { api, coordinator } = createHarness()
    await coordinator.start()

    expect(await coordinator.claim('run-duplicate')).toBe('claimed')
    expect(await coordinator.claim('run-duplicate')).toBe('duplicate')

    expect(api.claim).toHaveBeenCalledTimes(1)
  })

  it('接管本地登记接口原子返回的 lease，不再发起第二次 claim', async () => {
    const { api, coordinator, tick } = createHarness()
    await coordinator.start()

    expect(coordinator.adoptClaim('run-local', {
      outcome: 'claimed',
      run_id: 'run-local',
      lease_token: 'atomic-token',
      generation: 3,
    })).toBe(true)

    await tick()
    expect(api.claim).not.toHaveBeenCalled()
    expect(api.heartbeat).toHaveBeenCalledWith(
      'run-local',
      'electron:persistent-device-id',
      'atomic-token',
    )
  })

  it('heartbeat 被可恢复 fenced 后立刻重领，不中止本轮', async () => {
    const { api, coordinator, onFenced, tick } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-old')).toBe('claimed')
    vi.mocked(api.heartbeat).mockResolvedValueOnce({
      outcome: 'fenced',
      reason: FENCE_REASON_LEASE_EXPIRED,
      run_id: 'run-old',
    })
    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'claimed',
      run_id: 'run-old',
      lease_token: 'token-run-old-reclaimed',
      generation: 2,
    })

    await tick()

    expect(onFenced).not.toHaveBeenCalled()
    expect(api.claim).toHaveBeenCalledWith(
      'run-old',
      'electron:persistent-device-id',
    )
    expect(coordinator.leaseStore.get('run-old')?.leaseToken).toBe(
      'token-run-old-reclaimed',
    )
  })

  it('heartbeat 运输失败后立刻重领，不中止本轮', async () => {
    const { api, coordinator, onFenced, tick } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-net')).toBe('claimed')
    vi.mocked(api.heartbeat).mockRejectedValueOnce(new Error('HTTP 502'))
    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'claimed',
      run_id: 'run-net',
      lease_token: 'token-run-net-reclaimed',
      generation: 2,
    })

    await tick()

    expect(onFenced).not.toHaveBeenCalled()
    expect(api.claim).toHaveBeenCalledWith(
      'run-net',
      'electron:persistent-device-id',
    )
  })

  it('别人抢走执行权时 claim 得到 held 才 fence', async () => {
    const { api, coordinator, onFenced, tick } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-stolen')).toBe('claimed')
    vi.mocked(api.heartbeat).mockResolvedValueOnce({
      outcome: 'fenced',
      reason: FENCE_REASON_OWNERSHIP_TRANSFERRED,
      run_id: 'run-stolen',
    })
    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'held',
      reason: FENCE_REASON_HELD,
      run_id: 'run-stolen',
    })

    await tick()

    expect(onFenced).toHaveBeenCalledWith('run-stolen', FENCE_REASON_HELD)
    expect(api.claim).toHaveBeenCalledTimes(2)
    vi.mocked(api.heartbeat).mockClear()
    await coordinator.reconcile()
    expect(api.reconcile).toHaveBeenLastCalledWith(
      'electron:persistent-device-id',
      [],
    )
  })

  it('ownership_transferred 后同机重领成功则不中止', async () => {
    const { api, coordinator, onFenced, tick } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-rotated')).toBe('claimed')
    vi.mocked(api.heartbeat).mockResolvedValueOnce({
      outcome: 'fenced',
      reason: FENCE_REASON_OWNERSHIP_TRANSFERRED,
      run_id: 'run-rotated',
    })
    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'claimed',
      run_id: 'run-rotated',
      lease_token: 'token-run-rotated-2',
      generation: 2,
    })

    await tick()

    expect(onFenced).not.toHaveBeenCalled()
    expect(coordinator.leaseStore.get('run-rotated')?.leaseToken).toBe(
      'token-run-rotated-2',
    )
  })

  it('运输失败后 claim 投影不匹配则 fence', async () => {
    const { api, coordinator, onFenced, tick } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-mismatch')).toBe('claimed')
    vi.mocked(api.heartbeat).mockRejectedValueOnce(new Error('HTTP 502'))
    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'fenced',
      reason: FENCE_REASON_PROJECTION_MISMATCH,
      run_id: 'run-mismatch',
    })

    await tick()

    expect(onFenced).toHaveBeenCalledWith(
      'run-mismatch',
      FENCE_REASON_PROJECTION_MISMATCH,
    )
  })

  it('heartbeat 进行中 reconcile 排队；ownership_transferred 先重领', async () => {
    const { api, coordinator, onFenced, fireInterval } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-race')).toBe('claimed')

    let releaseHeartbeat: ((value: {
      outcome: 'fenced'
      reason: string
      run_id: string
    }) => void) | undefined
    vi.mocked(api.heartbeat).mockImplementationOnce(
      () => new Promise(resolve => {
        releaseHeartbeat = resolve
      }),
    )
    fireInterval()
    await vi.waitFor(() => {
      expect(api.heartbeat).toHaveBeenCalled()
    })

    let reconcileStarted = false
    vi.mocked(api.reconcile).mockImplementationOnce(async () => {
      reconcileStarted = true
      return {
        runs: [{
          outcome: 'renewed',
          run_id: 'run-race',
        }],
        converged_run_ids: [],
      }
    })
    const reconcileDone = coordinator.reconcile()
    await Promise.resolve()
    expect(reconcileStarted).toBe(false)

    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'claimed',
      run_id: 'run-race',
      lease_token: 'token-run-race-2',
      generation: 2,
    })
    releaseHeartbeat?.({
      outcome: 'fenced',
      reason: FENCE_REASON_OWNERSHIP_TRANSFERRED,
      run_id: 'run-race',
    })
    await reconcileDone

    expect(reconcileStarted).toBe(true)
    expect(onFenced).not.toHaveBeenCalled()
    expect(coordinator.leaseStore.get('run-race')?.leaseToken).toBe(
      'token-run-race-2',
    )
  })

  it('重连 reconcile 携带 active token；可恢复 fenced 会重领', async () => {
    const { api, coordinator, onFenced } = createHarness()
    await coordinator.start()
    expect(await coordinator.claim('run-reconnect')).toBe('claimed')
    vi.mocked(api.reconcile).mockResolvedValueOnce({
      runs: [{
        outcome: 'fenced',
        reason: FENCE_REASON_LEASE_EXPIRED,
        run_id: 'run-reconnect',
      }],
      converged_run_ids: [],
    })
    vi.mocked(api.claim).mockResolvedValueOnce({
      outcome: 'claimed',
      run_id: 'run-reconnect',
      lease_token: 'token-run-reconnect-2',
      generation: 2,
    })

    await coordinator.reconcile()

    expect(api.reconcile).toHaveBeenLastCalledWith(
      'electron:persistent-device-id',
      [{ run_id: 'run-reconnect', lease_token: 'token-run-reconnect' }],
    )
    expect(onFenced).not.toHaveBeenCalled()
    expect(api.claim).toHaveBeenCalledWith(
      'run-reconnect',
      'electron:persistent-device-id',
    )
  })
})

describe('ElectronAgentHost lease wiring', () => {
  const hostSource = readFileSync(
    resolve(__dirname, '..', 'ElectronAgentHost.ts'),
    'utf8',
  )

  it('只给带 run_id 的 forward claim，并在 query finally 停止 heartbeat', () => {
    expect(hostSource).toContain('const leasedRunId = request.runId')
    expect(hostSource).toContain(
      'await this.runHostLeaseCoordinator.claim(leasedRunId)',
    )
    expect(hostSource).toContain(
      'this.runHostLeaseCoordinator.stopTracking(leasedRunId)',
    )
  })

  it('启动及 WS 重连 reconcile，fenced 回调终止本地旧执行', () => {
    expect(hostSource).toContain('await this.runHostLeaseCoordinator.start()')
    expect(hostSource).toContain(
      'this.runHostLeaseReconnectUnsubscribe = electronWsGateway.onReconnect',
    )
    expect(hostSource).toContain('if (abortKey) this.handleAbort(abortKey)')
  })

  it('AgentHost admission 后沿现有 Gateway 确认 reliable forward', () => {
    expect(hostSource).toContain('PromptEvents.ADMITTED')
    expect(hostSource).toContain('{ buffered_event_id: eventId, run_id: runId }')
    expect(hostSource).toContain('{ threadId }')
    const replayCheck = hostSource.indexOf('hasAdmittedHostQuery(leasedRunId)')
    const leaseClaim = hostSource.indexOf('runHostLeaseCoordinator.claim(leasedRunId)')
    expect(replayCheck).toBeGreaterThan(0)
    expect(replayCheck).toBeLessThan(leaseClaim)
  })

  it('本机任务先交给 Runtime，再异步登记服务端 run', () => {
    const executeAt = hostSource.indexOf(
      'const begun = sharedHost.beginSubmitHostQuery(',
    )
    const registerAt = hostSource.indexOf(
      'const lease = await this.sessionRunRegistration.accept({',
    )

    expect(executeAt).toBeGreaterThan(0)
    expect(registerAt).toBeGreaterThan(executeAt)
    expect(hostSource).toContain('if (localRegistrationClosed) return')
    expect(hostSource).toContain('void begun.completion')
    expect(hostSource).toContain('deferRegistrationCleanup = true')
  })

  it('IPC 早 ACK 后保持登记开放，直到后台 run 真正结束', () => {
    expect(hostSource).toContain(
      `.finally(() => {
          localRegistrationClosed = true
          this.finishAcceptedQueryRegistration(runId)
        })`,
    )
    expect(hostSource).toContain(
      `if (!deferRegistrationCleanup) {
        localRegistrationClosed = true
        this.pendingTurnCtx.delete(runId)`,
    )
  })
})
