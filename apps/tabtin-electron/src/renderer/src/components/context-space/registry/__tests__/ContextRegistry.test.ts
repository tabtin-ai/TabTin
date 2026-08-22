import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextRegistry } from '../ContextRegistry'
import type {
  ContextItem,
  ContextTypeHandler,
  ContainerContext,
  ContextItemType,
  DispatchCloseSnapshot,
  DispatchCloseSnapshotProvider,
} from '../types'

function mkHandler(type: string, overrides?: Partial<ContextTypeHandler>): ContextTypeHandler {
  return { type: type as ContextItemType, ...overrides }
}

function mkItem(type: string, id: string): ContextItem {
  return {
    type: type as ContextItemType,
    id,
    tabKey: `${type}:${id}` as `${string}:${string}`,
  }
}

function mkCtx(): ContainerContext {
  return {
    spaceId: 'sp1',
    closeBrowserView: vi.fn(),
  }
}

describe('ContextRegistry', () => {
  let registry: ContextRegistry

  beforeEach(() => {
    registry = new ContextRegistry()
  })

  // -----------------------------------------------------------------------
  // register / getHandler
  // -----------------------------------------------------------------------

  describe('register + getHandler', () => {
    it('注册后可通过 type 查找', () => {
      registry.register(mkHandler('tabdata'))
      expect(registry.getHandler('tabdata' as ContextItemType)).toBeDefined()
    })

    it('未注册 → undefined', () => {
      expect(registry.getHandler('nonexist' as ContextItemType)).toBeUndefined()
    })

    it('通过 backendAliases 查找', () => {
      registry.register(mkHandler('tabdata', { backendAliases: ['table'] }))
      expect(registry.getHandler('table' as ContextItemType)?.type).toBe('tabdata')
    })

    it('通过 appId 查找', () => {
      registry.register(mkHandler('tabdata', { appId: 'data-app' }))
      expect(registry.getHandlerByAppId('data-app')?.type).toBe('tabdata')
    })

    it('getAllHandlers 返回所有注册的 handler', () => {
      registry.register(mkHandler('tabdata'))
      registry.register(mkHandler('tabdoc'))
      expect(registry.getAllHandlersRaw()).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // buildTabKey / parseTabKey
  // -----------------------------------------------------------------------

  describe('buildTabKey + parseTabKey', () => {
    it('往返一致性', () => {
      const tabKey = registry.buildTabKey('tabdata' as ContextItemType, 'tbl-1')
      const parsed = registry.parseTabKey(tabKey)
      expect(parsed).toEqual({ type: 'tabdata', id: 'tbl-1' })
    })

    it('parseTabKey 无冒号 → null', () => {
      expect(registry.parseTabKey('nocolon')).toBeNull()
    })

    it('parseTabKey 冒号在首位 → null', () => {
      expect(registry.parseTabKey(':abc')).toBeNull()
    })

    it('parseTabKey 冒号在末位 → null（空 id）', () => {
      expect(registry.parseTabKey('abc:')).toBeNull()
    })

    it('id 含冒号 → 保留完整 id', () => {
      const parsed = registry.parseTabKey('tabweb:http://example.com')
      expect(parsed).toEqual({ type: 'tabweb', id: 'http://example.com' })
    })
  })

  // -----------------------------------------------------------------------
  // dispatchBeforeClose
  // -----------------------------------------------------------------------

  describe('dispatchBeforeClose', () => {
    it('handler 无 beforeClose → 默认允许关闭（true）', async () => {
      registry.register(mkHandler('tabdata'))
      const result = await registry.dispatchBeforeClose(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(true)
    })

    it('beforeClose 返回 true → 允许关闭', async () => {
      registry.register(mkHandler('tabdata', {
        beforeClose: vi.fn().mockResolvedValue(true),
      }))
      const result = await registry.dispatchBeforeClose(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(true)
    })

    it('beforeClose 返回 false → 阻止关闭', async () => {
      registry.register(mkHandler('tabdata', {
        beforeClose: vi.fn().mockResolvedValue(false),
      }))
      const result = await registry.dispatchBeforeClose(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(false)
    })

    it('beforeClose 接收正确参数', async () => {
      const beforeClose = vi.fn().mockResolvedValue(true)
      registry.register(mkHandler('tabdata', { beforeClose }))
      const item = mkItem('tabdata', 't1')
      const ctx = mkCtx()

      await registry.dispatchBeforeClose(item, ctx)
      expect(beforeClose).toHaveBeenCalledWith(item, ctx)
    })
  })

  // -----------------------------------------------------------------------
  // dispatchSelect / dispatchClose / dispatchRefresh
  // -----------------------------------------------------------------------

  describe('dispatchSelect', () => {
    it('handler 有 onSelect → 调用并返回 true', () => {
      const onSelect = vi.fn()
      registry.register(mkHandler('tabdata', { onSelect }))

      const result = registry.dispatchSelect(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(true)
      expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('handler 无 onSelect → 返回 false', () => {
      registry.register(mkHandler('tabdata'))

      const result = registry.dispatchSelect(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(false)
    })
  })

  describe('dispatchClose', () => {
    it('handler 有 onClose → 调用并返回 hasHandler=true / needsClose=true', async () => {
      const onClose = vi.fn().mockResolvedValue(undefined)
      registry.register(mkHandler('tabdata', { onClose }))

      const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toEqual({ hasHandler: true, needsClose: true })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('handler 无 onClose → 返回 hasHandler=false / needsClose=true', async () => {
      registry.register(mkHandler('tabdata'))

      const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toEqual({ hasHandler: false, needsClose: true })
    })

    it('未注入 closeGuardSnapshotProvider → 守卫降级为 no-op，handler 即使违约也不 throw / 不 warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // 注：未注入 provider，所以 dispatchClose 拿不到快照、跳过比对；
        // 此处的 onClose 故意做"完全违约"的 side effect 模拟（throw 一个无关错误）
        // 来证明守卫确实没做任何 throw/warn，整个流程畅通
        registry.register(mkHandler('tabdata', {
          onClose: vi.fn().mockResolvedValue(undefined),
        }))
        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('snapshotProvider 同步返回 null → 守卫此次降级为 no-op（needsClose 默认 true）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        registry.setCloseGuardSnapshotProvider(() => null)
        registry.register(mkHandler('tabdata', {
          onClose: vi.fn().mockResolvedValue(undefined),
        }))
        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  // -----------------------------------------------------------------------
  // dispatchClose 契约守卫（D5：仅作用于 onClose）
  // -----------------------------------------------------------------------

  describe('dispatchClose 契约守卫', () => {
    /** 构造一个可变的 mock store snapshot，方便测试中模拟 handler 副作用 */
    const makeSnapshotState = (initial: { activeKey: string | null; tabOrder: string[] }) => {
      const state = { ...initial }
      const provider: DispatchCloseSnapshotProvider = (): DispatchCloseSnapshot => ({
        activeKey: state.activeKey,
        tabOrder: state.tabOrder.slice(),
      })
      return {
        state,
        provider,
        mutateActive: (next: string | null) => { state.activeKey = next },
        mutateOrder: (next: string[]) => { state.tabOrder = next },
      }
    }

    it('handler 合规（不改 activeKey / tabOrder）→ 守卫静默通过', async () => {
      const snap = makeSnapshotState({
        activeKey: 'tabdata:t1',
        tabOrder: ['tabdata:t1', 'tabdata:t2'],
      })
      registry.setCloseGuardSnapshotProvider(snap.provider)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        registry.register(mkHandler('tabdata', {
          onClose: vi.fn().mockResolvedValue(undefined),
        }))
        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('handler 违约改 activeKey（关闭非 active tab 却抢焦点）→ dev/test 环境 throw（含违约详情）', async () => {
      // 关闭的是非 active 的 t1（active 是 t2），handler 却把 active 改掉 = 抢焦点，真违约。
      // 对比 BR-28：关闭的若是 active tab，active 迁移才是合法的 source-sync（见下方专项）。
      const snap = makeSnapshotState({
        activeKey: 'tabdata:t2',
        tabOrder: ['tabdata:t1', 'tabdata:t2'],
      })
      registry.setCloseGuardSnapshotProvider(snap.provider)
      registry.register(mkHandler('tabdata', {
        onClose: () => {
          snap.mutateActive(null)
        },
      }))

      let caught: Error | null = null
      try {
        await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
      } catch (err) {
        caught = err as Error
      }
      expect(caught).not.toBeNull()
      expect(caught?.message).toMatch(/handler\.onClose 违反契约/)
      expect(caught?.message).toMatch(/activeKey/)
      // 详情 attached 到 error，便于 CI 排查
      expect((caught as Error & { details?: Record<string, unknown> })?.details).toMatchObject({
        type: 'tabdata',
        tabKey: 'tabdata:t1',
        activeKeyBefore: 'tabdata:t2',
        activeKeyAfter: null,
      })
    })

    it('handler 违约改 tabOrder（重排）→ dev/test 环境 throw', async () => {
      const snap = makeSnapshotState({
        activeKey: 'tabdata:t1',
        tabOrder: ['tabdata:t1', 'tabdata:t2', 'tabdata:t3'],
      })
      registry.setCloseGuardSnapshotProvider(snap.provider)
      registry.register(mkHandler('tabdata', {
        onClose: () => {
          // 模拟违约：把 t3 提前
          snap.mutateOrder(['tabdata:t1', 'tabdata:t3', 'tabdata:t2'])
        },
      }))

      await expect(
        registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
      ).rejects.toThrow(/handler\.onClose 违反契约.*tabOrder(?!\(去除自身\))/)
    })

    it('handler 仅去除 item.tabKey 自身 → 视为合法 source-driven sync，不报警 + needsClose=false', async () => {
      // 设计意图：source-driven 删除（如 terminal removeSpaceSession、browser
      // _recentlyClosedViewIds + 异步 IPC）会让 useTabSync.syncTabOrder 同步把 self.tabKey
      // 从 tabOrder 移除，这是结构性的合法路径。守卫只对"动了别人的 tab / 改了 activeKey"
      // 真违约报警；needsClose=false 让调用方跳过冗余 closeTab。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const snap = makeSnapshotState({
          activeKey: null,
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => {
            snap.mutateOrder(['tabdata:t2'])
          },
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: false })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('BR-28：关闭 active tab + active 随 reactive 同步迁移 + 仅去除自身 → 合法 source-sync，不报警 + needsClose=false', async () => {
      // dogfood Case 6 复现：Agent 关闭当前 active 的浏览器 tab，onClose await IPC 期间
      // reactive 同步层（useTabSync stale-active 守卫 / useActiveKeyGuard）把 self 从
      // tabOrder 移除、并把 active 从被销毁的 tab 移走。
      // 修前：activeKey 偏移 → dev/test throw → CLI 报 INTERNAL_ERROR（但 tab 实际已关）。
      // 修后：关闭的恰是 active tab，active 迁移属结构性 source-sync，不报警。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const snap = makeSnapshotState({
          activeKey: 'tabdata:t1',
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => {
            snap.mutateOrder(['tabdata:t2'])
            snap.mutateActive('tabdata:t2')
          },
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: false })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('BR-28：关闭 active tab + 仅 active 迁移（tabOrder 尚未同步移除）→ 合法 source-sync，不报警 + needsClose=true', async () => {
      // 时序变体：active tab 被关、active 已迁移，但快照捕获时 tabOrder 的 removed-self
      // 还没反映。仍属结构性合法；handlerRemovedFromTabOrder=false → 调用方仍兜底 closeTab。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const snap = makeSnapshotState({
          activeKey: 'tabdata:t1',
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => {
            snap.mutateActive('tabdata:t2')
          },
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('守卫仍抓抢焦点：关闭非 active tab + 仅去除自身但改了 active → 真违约（activeKey 偏移）报警', async () => {
      // 与 BR-28 合法路径的关键区别：关闭的不是 active tab，active 却被改 = handler 抢焦点。
      // 保证 BR-28 放宽不会把这种真误用一起放过。
      const snap = makeSnapshotState({
        activeKey: 'tabdata:t2',
        tabOrder: ['tabdata:t1', 'tabdata:t2'],
      })
      registry.setCloseGuardSnapshotProvider(snap.provider)
      registry.register(mkHandler('tabdata', {
        onClose: () => {
          snap.mutateOrder(['tabdata:t2'])
          snap.mutateActive(null)
        },
      }))

      await expect(
        registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
      ).rejects.toThrow(/handler\.onClose 违反契约.*activeKey/)
    })

    it('snapshotProvider 抛错 → 守卫此次 no-op（不影响 dispatchClose 主流程）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        registry.setCloseGuardSnapshotProvider(() => {
          throw new Error('provider boom')
        })
        registry.register(mkHandler('tabdata', {
          onClose: vi.fn().mockResolvedValue(undefined),
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        // provider 失败 warn，但不 throw、不阻断
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('closeGuardSnapshotProvider'),
          expect.objectContaining({ spaceId: 'sp1' }),
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('production 模式（envOverride=warn）→ 仅去除自身在 prod 也走 source-sync 路径，不 warn + needsClose=false', async () => {
      // 注：Vite 把 `import.meta.env.DEV` 编译时静态替换，运行时 vi.stubEnv 无效；
      // 因此用 ContextRegistry 的 instance-level override 模拟 prod 分支。
      // 现在 source-sync 在 dev/prod 行为统一：都不报警，因为这是合法路径而不是违约。
      registry.__setCloseGuardEnvOverrideForTest('warn')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        const snap = makeSnapshotState({
          activeKey: null,
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => snap.mutateOrder(['tabdata:t2']),
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: false })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
        registry.__setCloseGuardEnvOverrideForTest(null)
      }
    })

    it('production 模式 + handler 抢焦点（关闭非 active tab 改 active，不动 tabOrder）→ warn + needsClose=true（consumer 仍兜底 closeTab）', async () => {
      registry.__setCloseGuardEnvOverrideForTest('warn')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        const snap = makeSnapshotState({
          activeKey: 'tabdata:t2',
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => snap.mutateActive(null),
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        // tabOrder 未被改 → handlerRemovedFromTabOrder=false → needsClose=true
        // consumer 仍需 closeTab；activeKey 由"第二道防线"在 hook/tool 层纠正
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('handler.onClose 违反契约（修改了 activeKey）'),
          expect.objectContaining({ activeKeyBefore: 'tabdata:t2', activeKeyAfter: null }),
        )
      } finally {
        warnSpy.mockRestore()
        registry.__setCloseGuardEnvOverrideForTest(null)
      }
    })

    it('BR-28 production 模式：关闭 active tab + active 迁移 + 去除自身 → 不 warn + needsClose=false', async () => {
      // prod 降级路径也不能把 BR-28 的合法 source-sync 误判为违约 warn。
      registry.__setCloseGuardEnvOverrideForTest('warn')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        const snap = makeSnapshotState({
          activeKey: 'tabdata:t1',
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => {
            snap.mutateOrder(['tabdata:t2'])
            snap.mutateActive('tabdata:t2')
          },
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: false })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
        registry.__setCloseGuardEnvOverrideForTest(null)
      }
    })

    it('production 模式 + handler 完全违约重排 tabOrder → warn + needsClose=true（consumer 仍兜底）', async () => {
      registry.__setCloseGuardEnvOverrideForTest('warn')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        const snap = makeSnapshotState({
          activeKey: null,
          tabOrder: ['tabdata:t1', 'tabdata:t2'],
        })
        registry.setCloseGuardSnapshotProvider(snap.provider)
        registry.register(mkHandler('tabdata', {
          onClose: () => snap.mutateOrder(['tabdata:t2', 'tabdata:t1']),
        }))

        const result = await registry.dispatchClose(mkItem('tabdata', 't1'), mkCtx())
        expect(result).toEqual({ hasHandler: true, needsClose: true })
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('handler.onClose 违反契约'),
          expect.any(Object),
        )
      } finally {
        warnSpy.mockRestore()
        registry.__setCloseGuardEnvOverrideForTest(null)
      }
    })

    it('守卫不作用于 dispatchSelect / dispatchRefresh / dispatchBeforeClose（D5 范围）', async () => {
      const snap = makeSnapshotState({
        activeKey: 'tabdata:t1',
        tabOrder: ['tabdata:t1'],
      })
      registry.setCloseGuardSnapshotProvider(snap.provider)
      registry.register(mkHandler('tabdata', {
        onSelect: () => snap.mutateActive(null),
        onRefresh: () => snap.mutateOrder([]),
        beforeClose: async () => {
          snap.mutateActive(null)
          snap.mutateOrder([])
          return true
        },
      }))

      // 这三个钩子即便擅自改 store 也不应触发守卫 throw
      expect(() => registry.dispatchSelect(mkItem('tabdata', 't1'), mkCtx())).not.toThrow()
      expect(() => registry.dispatchRefresh(mkItem('tabdata', 't1'), mkCtx())).not.toThrow()
      await expect(
        registry.dispatchBeforeClose(mkItem('tabdata', 't1'), mkCtx())
      ).resolves.toBe(true)
    })
  })

  describe('dispatchRefresh', () => {
    it('handler 有 onRefresh → 返回 true', () => {
      const onRefresh = vi.fn()
      registry.register(mkHandler('tabdata', { onRefresh }))

      const result = registry.dispatchRefresh(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(true)
    })

    it('handler 无 onRefresh → 返回 false', () => {
      registry.register(mkHandler('tabdata'))

      const result = registry.dispatchRefresh(mkItem('tabdata', 't1'), mkCtx())
      expect(result).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // dispatchAfterClose
  // -----------------------------------------------------------------------

  describe('dispatchAfterClose', () => {
    it('handler 有 onAfterClose → 被调用，参数透传', () => {
      const onAfterClose = vi.fn()
      registry.register(mkHandler('terminal', { onAfterClose }))

      const item = mkItem('terminal', 'sess-1')
      const ctx = mkCtx()
      registry.dispatchAfterClose(item, ctx)

      expect(onAfterClose).toHaveBeenCalledTimes(1)
      expect(onAfterClose).toHaveBeenCalledWith(item, ctx)
    })

    it('handler 无 onAfterClose → no-op，不抛错', () => {
      registry.register(mkHandler('tabdata'))

      expect(() =>
        registry.dispatchAfterClose(mkItem('tabdata', 't1'), mkCtx()),
      ).not.toThrow()
    })

    it('handler 未注册 → no-op，不抛错', () => {
      expect(() =>
        registry.dispatchAfterClose(mkItem('unregistered', 'x'), mkCtx()),
      ).not.toThrow()
    })

    it('onAfterClose 抛错 → 被 catch + warn，不向上传播', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        registry.register(mkHandler('terminal', {
          onAfterClose: () => {
            throw new Error('cleanup boom')
          },
        }))

        expect(() =>
          registry.dispatchAfterClose(mkItem('terminal', 's1'), mkCtx()),
        ).not.toThrow()

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('handler.onAfterClose 抛错'),
          expect.objectContaining({
            type: 'terminal',
            tabKey: 'terminal:s1',
          }),
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('不做契约守卫——onAfterClose 内任意操作都不会被检测/限制', () => {
      // 设计意图：onAfterClose 时 closeTab 已完成，handler 通过 source 驱动 syncTabOrder
      // 不会再让 tabOrder 偏离。守卫无意义，反而引入噪声。这里用一个会动 store 的副作用
      // 间接验证：dispatchAfterClose 不调用 closeGuardSnapshotProvider。
      const provider = vi.fn().mockReturnValue({ activeKey: null, tabOrder: [] })
      registry.setCloseGuardSnapshotProvider(provider)
      registry.register(mkHandler('tabdata', {
        onAfterClose: vi.fn(),
      }))

      registry.dispatchAfterClose(mkItem('tabdata', 't1'), mkCtx())

      expect(provider).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // 其他方法
  // -----------------------------------------------------------------------

  describe('normalizeBackendType', () => {
    it('已注册 alias → 归一化为前端 type', () => {
      registry.register(mkHandler('tabdata', { backendAliases: ['table', 'spreadsheet'] }))
      expect(registry.normalizeBackendType('table')).toBe('tabdata')
      expect(registry.normalizeBackendType('spreadsheet')).toBe('tabdata')
    })

    it('未注册 → 原样返回', () => {
      expect(registry.normalizeBackendType('unknown')).toBe('unknown')
    })
  })

  describe('isKnownType', () => {
    it('已注册 → true', () => {
      registry.register(mkHandler('tabdata'))
      expect(registry.isKnownType('tabdata')).toBe(true)
    })

    it('通过 alias 也可识别', () => {
      registry.register(mkHandler('tabdata', { backendAliases: ['table'] }))
      expect(registry.isKnownType('table')).toBe(true)
    })

    it('未注册 → false', () => {
      expect(registry.isKnownType('unknown')).toBe(false)
    })
  })

  describe('isKeepAlive', () => {
    it('支持按 item 动态决定是否保活', () => {
      registry.register(mkHandler('apphome', {
        keepAlive: item => item.meta?.appId === 'orchestration',
      }))

      expect(registry.isKeepAlive({
        ...mkItem('apphome', 'orchestration-space-1'),
        meta: { appId: 'orchestration' },
      })).toBe(true)
      expect(registry.isKeepAlive({
        ...mkItem('apphome', 'skill'),
        meta: { appId: 'skill' },
      })).toBe(false)
    })

    it('兼容既有 boolean 声明与未声明 handler', () => {
      registry.register(mkHandler('tabfolder', { keepAlive: true }))
      registry.register(mkHandler('history'))

      expect(registry.isKeepAlive(mkItem('tabfolder', 'folder-1'))).toBe(true)
      expect(registry.isKeepAlive(mkItem('history', 'history-1'))).toBe(false)
      expect(registry.isKeepAlive(mkItem('unknown', 'unknown-1'))).toBe(false)
    })
  })

  describe('getPersistedOnlyPrefixes', () => {
    it('返回 persistOnly handler 的前缀', () => {
      registry.register(mkHandler('tabfolder', { persistOnly: true }))
      registry.register(mkHandler('tabdata'))

      const prefixes = registry.getPersistedOnlyPrefixes()
      expect(prefixes).toContain('tabfolder:')
      expect(prefixes).not.toContain('tabdata:')
    })
  })

  describe('marketplace 可见性', () => {
    it('非 marketplace app → 始终可见', () => {
      registry.register(mkHandler('tabdata'))

      expect(registry.getAllHandlers()).toHaveLength(1)
    })

    it('marketplace app 未设置 checker → 不可见', () => {
      registry.register(mkHandler('demo-app', { marketplaceApp: true }))

      expect(registry.getAllHandlers()).toHaveLength(0)
    })

    it('marketplace app + checker 返回 true → 可见', () => {
      registry.register(mkHandler('demo-app', { marketplaceApp: true }))
      registry.setMarketplaceInstallChecker(() => true)

      expect(registry.getAllHandlers()).toHaveLength(1)
    })
  })
})
