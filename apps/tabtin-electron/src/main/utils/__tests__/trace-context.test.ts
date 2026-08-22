/**
 * Wave 1 D3 — trace-context unit tests.
 *
 * 验证 AsyncLocalStorage 跨 await / Promise.resolve / setTimeout
 * 边界 trace_id 不丢失。这是整个 trace 透传路径的载体——丢一处
 * envelope.trace_id 就会变 undefined，audit log 跨表 join 就断。
 *
 * 不要用 fake timers 测 setTimeout 路径——ALS 的实现依赖真实 timer
 * 链路上的 async resource hook，fake 出来的 timer 不一定保留 store。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getCurrentTraceId,
  generateTraceId,
  runWithTraceId,
  runWithGeneratedTrace,
  setCurrentTraceId,
  stampTraceIntoEnvelope,
  __disableTraceContextForTesting,
} from '../trace-context'

describe('trace-context', () => {
  beforeEach(() => {
    __disableTraceContextForTesting()
  })
  afterEach(() => {
    __disableTraceContextForTesting()
  })

  describe('generateTraceId', () => {
    it('returns a 12-char base62-ish string', () => {
      const id = generateTraceId()
      expect(typeof id).toBe('string')
      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/)
    })

    it('is sufficiently unique under tight loops', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i++) ids.add(generateTraceId())
      expect(ids.size).toBe(1000)
    })
  })

  describe('getCurrentTraceId', () => {
    it('returns undefined outside any ALS context', () => {
      expect(getCurrentTraceId()).toBeUndefined()
    })

    it('returns the trace inside runWithTraceId', () => {
      runWithTraceId('fixed-trace', () => {
        expect(getCurrentTraceId()).toBe('fixed-trace')
      })
    })

    it('returns the generated trace inside runWithGeneratedTrace', () => {
      runWithGeneratedTrace(() => {
        const tid = getCurrentTraceId()
        expect(tid).toBeTypeOf('string')
        expect(tid).toMatch(/^[A-Za-z0-9_-]{12}$/)
      })
    })

    it('returns undefined again after the run callback returns', () => {
      runWithTraceId('within', () => {
        expect(getCurrentTraceId()).toBe('within')
      })
      expect(getCurrentTraceId()).toBeUndefined()
    })
  })

  describe('cross-await propagation', () => {
    it('trace_id survives a single Promise.resolve await', async () => {
      await runWithTraceId('await-1', async () => {
        await Promise.resolve()
        expect(getCurrentTraceId()).toBe('await-1')
      })
    })

    it('trace_id survives a setTimeout boundary', async () => {
      await runWithTraceId('await-timer', async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 1))
        expect(getCurrentTraceId()).toBe('await-timer')
      })
    })

    it('trace_id survives nested async helpers', async () => {
      const nested = async () => {
        await Promise.resolve()
        await new Promise<void>(resolve => queueMicrotask(resolve))
        return getCurrentTraceId()
      }

      const result = await runWithTraceId('await-nested', async () => {
        return await nested()
      })
      expect(result).toBe('await-nested')
    })

    it('parallel Promise.all branches each see the same outer trace', async () => {
      const out = await runWithTraceId('await-parallel', async () => {
        const [a, b, c] = await Promise.all([
          (async () => {
            await Promise.resolve()
            return getCurrentTraceId()
          })(),
          (async () => {
            await new Promise<void>(resolve => setImmediate(resolve))
            return getCurrentTraceId()
          })(),
          (async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 1))
            return getCurrentTraceId()
          })(),
        ])
        return [a, b, c]
      })
      expect(out).toEqual(['await-parallel', 'await-parallel', 'await-parallel'])
    })

    it('two outer runWithTraceId calls do not leak into each other (parallel safety)', async () => {
      const seen: string[] = []
      const branch = (id: string, delay: number) =>
        runWithTraceId(id, async () => {
          await new Promise<void>(resolve => setTimeout(resolve, delay))
          seen.push(`${id}->${getCurrentTraceId()}`)
        })

      await Promise.all([branch('A', 5), branch('B', 1), branch('C', 3)])

      // 每个分支看到的只能是它自己的 trace；3 条记录顺序不重要
      expect(seen.sort()).toEqual(['A->A', 'B->B', 'C->C'])
    })
  })

  describe('setCurrentTraceId', () => {
    it('mutates the store inside an active context', () => {
      runWithTraceId('initial', () => {
        setCurrentTraceId('updated')
        expect(getCurrentTraceId()).toBe('updated')
      })
    })

    it('is silently ignored outside any context (no throw, no leak)', () => {
      expect(() => setCurrentTraceId('orphan')).not.toThrow()
      expect(getCurrentTraceId()).toBeUndefined()
    })
  })

  describe('stampTraceIntoEnvelope', () => {
    it('mutates an envelope-shaped object to include current trace_id', () => {
      runWithTraceId('stamp-trace', () => {
        const env = { ok: true as const, data: { id: 1 } }
        const out = stampTraceIntoEnvelope(env)
        expect(out).toBe(env) // mutate in-place, not copy
        expect((env as any).trace_id).toBe('stamp-trace')
      })
    })

    it('respects existing trace_id on envelope (no overwrite)', () => {
      runWithTraceId('stamp-outer', () => {
        const env = { ok: true as const, data: 1, trace_id: 'preset' }
        stampTraceIntoEnvelope(env)
        expect(env.trace_id).toBe('preset')
      })
    })

    it('does NOT touch non-envelope objects (no `ok` field)', () => {
      runWithTraceId('stamp-nonenv', () => {
        const raw = { data: { items: [] } }
        stampTraceIntoEnvelope(raw)
        expect(raw).not.toHaveProperty('trace_id')
      })
    })

    it('does NOT touch primitives / null / undefined', () => {
      runWithTraceId('stamp-prim', () => {
        expect(stampTraceIntoEnvelope(null)).toBeNull()
        expect(stampTraceIntoEnvelope(undefined)).toBeUndefined()
        expect(stampTraceIntoEnvelope(42)).toBe(42)
        expect(stampTraceIntoEnvelope('hello')).toBe('hello')
      })
    })

    it('outside any ALS context, returns the value unchanged', () => {
      const env = { ok: false as const, error: { code: 'X', message: 'm', retryable: false } }
      stampTraceIntoEnvelope(env)
      expect(env).not.toHaveProperty('trace_id')
    })

    it('rejects shapes where `ok` is not boolean (defensive)', () => {
      runWithTraceId('stamp-defensive', () => {
        const fake = { ok: 'truthy', data: 1 }
        stampTraceIntoEnvelope(fake)
        expect(fake).not.toHaveProperty('trace_id')
      })
    })
  })

  describe('runWithGeneratedTrace', () => {
    it('exposes a fresh trace each call', () => {
      const tids: Array<string | undefined> = []
      runWithGeneratedTrace(() => tids.push(getCurrentTraceId()))
      runWithGeneratedTrace(() => tids.push(getCurrentTraceId()))
      runWithGeneratedTrace(() => tids.push(getCurrentTraceId()))
      expect(new Set(tids).size).toBe(3)
    })
  })
})
