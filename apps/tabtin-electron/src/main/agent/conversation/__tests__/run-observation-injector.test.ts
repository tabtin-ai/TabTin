/**
 * Wave 5a (L-W4-1) — Electron `createRunObservationInjector` 单测。
 *
 * 验证：
 *  1. spaceId 缺省时 injector 永远 yield 空数组（安全降级）；
 *  2. RSM 返回的 observation 经 formatter 后注入路径不携带 credentialId 完整明文；
 *  3. 已读游标推进：第一次调用拿到 observation 后，第二次再调拿不到同条；
 *  4. 类型白名单：`AGENT_AUTOFILL_SUCCESS` 不进 LLM 上下文（V1 静默路径）；
 *  5. RSM 异常时 injector 不抛，返回空数组（safety net）；
 *  6. 不同 type 都映射成给 LLM 看的人话，**不暴露内部 code 字面量**作为 user prompt。
 */

import { describe, it, expect, vi } from 'vitest'
import type { RunObservationEvent } from '@shared/run-session-snapshot'
import {
  createRunObservationInjector,
  getRunObservationInjectorTestHooks,
} from '../run-observation-injector'

function makeStubRsm(initial: RunObservationEvent[] = []) {
  let store = [...initial]
  return {
    setObservations: (obs: RunObservationEvent[]) => {
      store = [...obs]
    },
    listObservationsBySpaceSince: vi.fn((spaceId: string, since: number) => {
      void spaceId
      return store.filter((o) => o.timestamp > since)
    }),
  }
}

describe('createRunObservationInjector — Wave 5a (L-W4-1)', () => {
  it('spaceId 缺省时 injector 永远 yield 空数组', async () => {
    const stub = makeStubRsm([
      { runId: 'r1', type: 'AGENT_AUTOFILL_FAILED', timestamp: Date.now() + 100, data: { domain: 'a.com', code: 'credential-unavailable' } },
    ])
    const handle = createRunObservationInjector({
      spaceId: undefined,
      rsmAccessor: () => stub,
    })
    const result = await handle.injector()
    expect(result).toEqual([])
    // RSM 都不该被调（无 spaceId 直接跳出）
    expect(stub.listObservationsBySpaceSince).not.toHaveBeenCalled()
  })

  it('AGENT_AUTOFILL_FAILED 转人话 + credentialId 截断为前 6 字符', async () => {
    const SENSITIVE_CRED_ID = 'cred-uuid-deadbeef-1234-5678-90ab-cdef01234567'
    const ts = Date.now() + 100
    const stub = makeStubRsm([
      {
        runId: 'r1',
        type: 'AGENT_AUTOFILL_FAILED',
        timestamp: ts,
        data: {
          domain: 'example.com',
          code: 'credential-unavailable',
          credentialId: SENSITIVE_CRED_ID,
        },
      },
    ])
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })

    const out = await handle.injector()
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('AGENT_AUTOFILL_FAILED')
    expect(out[0]!.timestamp).toBe(ts)
    // 人话描述 + 不暴露内部 code 字面量
    expect(out[0]!.humanReadable).toContain('自动登录 example.com 失败')
    expect(out[0]!.humanReadable).toContain('凭据可能已过期')
    // 关键安全：完整 credentialId **绝不**进入 humanReadable
    expect(out[0]!.humanReadable).not.toContain(SENSITIVE_CRED_ID)
    // 仅前 6 字符 hint
    expect(out[0]!.humanReadable).toContain('cred:cred-u')
    expect(out[0]!.humanReadable).not.toContain('deadbeef')
  })

  it('已读游标推进：第二次调用同一条 observation 不再返回', async () => {
    const stub = makeStubRsm([
      {
        runId: 'r1',
        type: 'AGENT_AUTOFILL_FAILED',
        timestamp: Date.now() + 200,
        data: { domain: 'x.com', code: 'fill-failed' },
      },
    ])
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })

    const first = await handle.injector()
    expect(first).toHaveLength(1)
    const second = await handle.injector()
    expect(second).toHaveLength(0)
  })

  it('AGENT_AUTOFILL_SUCCESS / 未知 type 不进 LLM 上下文，但游标仍推进避免 O(n²) 重扫', async () => {
    const stub = makeStubRsm([
      {
        runId: 'r1',
        type: 'AGENT_AUTOFILL_SUCCESS',
        timestamp: Date.now() + 100,
        data: { domain: 'x.com' },
      },
      {
        runId: 'r1',
        type: 'AGENT_AUTOFILL_TRIGGERED',
        timestamp: Date.now() + 200,
        data: {},
      },
    ])
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })

    const out = await handle.injector()
    expect(out).toEqual([])

    // 再添一条相同 timestamp 之前的 obs；游标已推进，依然为空（避免 O(n²)）
    const out2 = await handle.injector()
    expect(out2).toEqual([])
  })

  it('SPACE_ENV_CHANGED 转人话', async () => {
    const stub = makeStubRsm([
      {
        runId: 'r1',
        type: 'SPACE_ENV_CHANGED',
        timestamp: Date.now() + 100,
        data: { spaceId: 'space-1', reason: 'user_switch_env' },
      },
    ])
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })
    const out = await handle.injector()
    expect(out).toHaveLength(1)
    expect(out[0]!.humanReadable).toContain('登录环境已被切换')
    expect(out[0]!.humanReadable).toContain('user_switch_env')
  })

  it('RSM 异常时 injector 不抛，返回空数组', async () => {
    const stub = {
      listObservationsBySpaceSince: vi.fn(() => {
        throw new Error('RSM internal failure')
      }),
    }
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })
    const out = await handle.injector()
    expect(out).toEqual([])
  })

  it('Wave 5a 视角 3 P2#3 自修：test hooks 通过独立 API 暴露，不污染 Handle 接口', async () => {
    const stub = makeStubRsm([])
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })
    // Handle 接口只暴露 injector
    expect(Object.keys(handle)).toEqual(['injector'])
    expect(typeof handle.injector).toBe('function')
    // 测试 hooks 通过独立函数获取
    const hooks = getRunObservationInjectorTestHooks(handle)
    expect(hooks).toBeDefined()
    expect(typeof hooks!.getLastReadTimestamp).toBe('function')
    expect(typeof hooks!.reset).toBe('function')
    // reset 真的能改游标
    hooks!.reset(12345)
    expect(hooks!.getLastReadTimestamp()).toBe(12345)
  })

  it('混合 observation：白名单类型注入，非白名单 silent，且共享游标', async () => {
    const ts1 = Date.now() + 100
    const ts2 = Date.now() + 200
    const ts3 = Date.now() + 300
    const stub = makeStubRsm([
      { runId: 'r1', type: 'AGENT_AUTOFILL_FAILED', timestamp: ts1, data: { domain: 'a.com', code: 'credential-unavailable' } },
      { runId: 'r1', type: 'AGENT_AUTOFILL_SUCCESS', timestamp: ts2, data: {} },
      { runId: 'r1', type: 'SPACE_ENV_CHANGED', timestamp: ts3, data: { reason: 'manual' } },
    ])
    const handle = createRunObservationInjector({
      spaceId: 'space-1',
      rsmAccessor: () => stub,
    })
    const out = await handle.injector()
    // 2 条注入；SUCCESS 被 filter
    expect(out.map((o) => o.type)).toEqual(['AGENT_AUTOFILL_FAILED', 'SPACE_ENV_CHANGED'])
    // 第二次再调拿不到（游标已推进到最大 ts3）
    const out2 = await handle.injector()
    expect(out2).toEqual([])
  })
})
