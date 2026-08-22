/**
 * Wave 2A 限流退避策略单元测试 — 钉死协议 §3.2 + §3.4 落地。
 *
 * 覆盖矩阵:
 *  1. `get429MaxRetriesForMethod` — GET/PUT/PATCH/DELETE/HEAD/OPTIONS=3,POST=1
 *  2. `compute429BackoffMs` — 指数退避 + jitter 边界
 *  3. `resolve429RetryAfterMs` — > 60s 让用户感知;ceiling=10s
 *  4. `extractRetryAfterFromProxyResult` — body 优先,header fallback,
 *     非法值返 null(避免雷击群效应)
 *
 * 协议来源:`docs/api/rate-limit-protocol.md` §3。
 * 数字依据:总控 §1 决策 + F-3 反思要求所有数字写明依据。
 */
import { describe, expect, it } from 'vitest'
import {
  IDEMPOTENT_429_MAX_RETRIES,
  NON_IDEMPOTENT_429_MAX_RETRIES,
  get429MaxRetriesForMethod,
  compute429BackoffMs,
  resolve429RetryAfterMs,
  extractRetryAfterFromProxyResult,
} from './api-retry-config'

describe('Wave 2A — get429MaxRetriesForMethod(协议 §3.4)', () => {
  it('GET 是幂等方法,默认重试 3 次(协议 §3.2 推荐值)', () => {
    expect(get429MaxRetriesForMethod('GET')).toBe(IDEMPOTENT_429_MAX_RETRIES)
    expect(get429MaxRetriesForMethod('GET')).toBe(3)
  })

  it('PUT / PATCH / DELETE / HEAD / OPTIONS 都是幂等,重试 3 次', () => {
    for (const m of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(get429MaxRetriesForMethod(m)).toBe(3)
    }
  })

  it('POST 是非幂等,只重试 1 次(防副作用重复)', () => {
    expect(get429MaxRetriesForMethod('POST')).toBe(NON_IDEMPOTENT_429_MAX_RETRIES)
    expect(get429MaxRetriesForMethod('POST')).toBe(1)
  })

  it('小写方法名也能识别(大小写不敏感)', () => {
    expect(get429MaxRetriesForMethod('post')).toBe(1)
    expect(get429MaxRetriesForMethod('get')).toBe(3)
  })
})

describe('Wave 2A — compute429BackoffMs(协议 §3.2 指数退避)', () => {
  it('attempt=0 时 base=10s 返 ~10s(±20% jitter)', () => {
    // 用确定性 random 让结果可断言
    const noJitter = () => 0.5 // jitter = 0
    expect(compute429BackoffMs(0, 10, noJitter)).toBe(10_000)
  })

  it('attempt=1 时 base=10s 返 ~20s(指数退避 2^1)', () => {
    const noJitter = () => 0.5
    expect(compute429BackoffMs(1, 10, noJitter)).toBe(20_000)
  })

  it('attempt=2 时 base=5s 返 ~20s(2^2 * 5)', () => {
    const noJitter = () => 0.5
    expect(compute429BackoffMs(2, 5, noJitter)).toBe(20_000)
  })

  it('jitter ±20% 内,最小返 1000ms(避免负数 / 过短)', () => {
    // random=0 → jitter=-20%,base=1s → 1000 - 200 = 800,floored 到 1000
    const minRandom = () => 0
    expect(compute429BackoffMs(0, 1, minRandom)).toBe(1000)
  })

  it('baseSeconds < 1 时 floor 到 1(防御性)', () => {
    const noJitter = () => 0.5
    expect(compute429BackoffMs(0, 0, noJitter)).toBe(1000)
    expect(compute429BackoffMs(0, -5, noJitter)).toBe(1000)
  })
})

describe('Wave 2A — resolve429RetryAfterMs(协议 §3.4)', () => {
  it('retry_after <= 60s 且 backoff <= 10s,返 backoff', () => {
    expect(resolve429RetryAfterMs(5, 5_000)).toBe(5_000)
  })

  it('retry_after > 60s,返 0 让用户感知(协议 §3.4)', () => {
    expect(resolve429RetryAfterMs(120, 5_000)).toBe(0)
  })

  it('backoff > ceiling 10s,返 ceiling', () => {
    expect(resolve429RetryAfterMs(5, 30_000)).toBe(10_000)
  })

  it('retry_after < 1 视为非法,返 0', () => {
    expect(resolve429RetryAfterMs(0, 5_000)).toBe(0)
    expect(resolve429RetryAfterMs(-1, 5_000)).toBe(0)
  })
})

describe('Wave 2A — extractRetryAfterFromProxyResult(协议 §3.1)', () => {
  it('优先读 body.retry_after_seconds', () => {
    const result = {
      data: { retry_after_seconds: 42 },
      headers: { 'retry-after': '99' },
    }
    expect(extractRetryAfterFromProxyResult(result)).toBe(42)
  })

  it('body 缺失时 fallback 到 Retry-After header', () => {
    const result = {
      data: { other: 'noise' },
      headers: { 'retry-after': '17' },
    }
    expect(extractRetryAfterFromProxyResult(result)).toBe(17)
  })

  it('body 字段非整数时被忽略,fallback header', () => {
    const result = {
      data: { retry_after_seconds: '12' }, // 字符串非法
      headers: { 'retry-after': '20' },
    }
    expect(extractRetryAfterFromProxyResult(result)).toBe(20)
  })

  it('body=0 / 负数视为缺失(防雷击群效应)', () => {
    const result = {
      data: { retry_after_seconds: 0 },
      headers: { 'retry-after': '7' },
    }
    expect(extractRetryAfterFromProxyResult(result)).toBe(7)
  })

  it('两面都缺失返 null', () => {
    expect(extractRetryAfterFromProxyResult({ data: {}, headers: {} })).toBeNull()
    expect(extractRetryAfterFromProxyResult({} as any)).toBeNull()
  })

  it('非 JSON body(string) 不影响 header fallback', () => {
    const result = {
      data: 'plain text',
      headers: { 'retry-after': '8' },
    }
    expect(extractRetryAfterFromProxyResult(result)).toBe(8)
  })
})
