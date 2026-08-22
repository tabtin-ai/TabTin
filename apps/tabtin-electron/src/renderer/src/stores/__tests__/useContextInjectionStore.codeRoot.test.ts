import { beforeEach, describe, expect, it } from 'vitest'
import { useContextInjectionStore } from '../useContextInjectionStore'
import { useSessionBoundCodeRootStore } from '../useSessionBoundCodeRootStore'
import { createContextRef } from '@/components/chat/types'

/**
 *  不变量 #4：同一 scope 内允许同根多个代码文件；拒绝加入 rootPath 与
 * 当前绑定 root 不同的新代码引用；换根后清理旧 root 的未发送代码引用，
 * 非代码引用保留。
 */
describe('useContextInjectionStore — 会话代码根校验', () => {
  beforeEach(() => {
    useContextInjectionStore.setState({ activeScopeId: null, contextRefsByScopeId: {} })
    useSessionBoundCodeRootStore.setState({ bindingsBySessionId: {}, nextRevision: 1 })
  })

  it('未绑定代码根时，添加 code_file 引用不受限制', () => {
    const result = useContextInjectionStore.getState().addRefToScope(
      'sess-1',
      createContextRef('code_file', '/repo/a/src/index.ts', 'index.ts', {
        meta: { filePath: '/repo/a/src/index.ts', rootPath: '/repo/a' },
      }),
    )

    expect(result).toEqual({ ok: true })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['sess-1']).toHaveLength(1)
  })

  it('绑定代码根后，同根的多个代码文件都允许加入', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('sess-1', { rootPath: '/repo/bound' })

    const r1 = useContextInjectionStore.getState().addRefToScope(
      'sess-1',
      createContextRef('code_file', '/repo/bound/a.ts', 'a.ts', {
        meta: { filePath: '/repo/bound/a.ts', rootPath: '/repo/bound' },
      }),
    )
    const r2 = useContextInjectionStore.getState().addRefToScope(
      'sess-1',
      createContextRef('code_selection', '/repo/bound/b.ts', 'b.ts', {
        meta: { filePath: '/repo/bound/b.ts', rootPath: '/repo/bound', startLine: 1, endLine: 5 },
      }),
    )

    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['sess-1']).toHaveLength(2)
  })

  it('绑定代码根后，拒绝加入 rootPath 不同的代码引用', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('sess-1', { rootPath: '/repo/bound' })

    const result = useContextInjectionStore.getState().addRefToScope(
      'sess-1',
      createContextRef('code_file', '/repo/other/a.ts', 'a.ts', {
        meta: { filePath: '/repo/other/a.ts', rootPath: '/repo/other' },
      }),
    )

    expect(result).toEqual({
      ok: false,
      reason: 'code_root_mismatch',
      boundRootPath: '/repo/bound',
      attemptedRootPath: '/repo/other',
    })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['sess-1']).toBeUndefined()
  })

  it('非代码引用不受代码根校验影响', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('sess-1', { rootPath: '/repo/bound' })

    const result = useContextInjectionStore.getState().addRefToScope(
      'sess-1',
      createContextRef('document', 'doc-1', '产品说明'),
    )

    expect(result).toEqual({ ok: true })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['sess-1']).toHaveLength(1)
  })

  it('pruneCodeRefsForRootChange 移除旧根的代码引用，保留非代码引用与新根引用', () => {
    useContextInjectionStore.setState({
      contextRefsByScopeId: {
        'sess-1': [
          createContextRef('code_file', '/repo/old/a.ts', 'a.ts', {
            meta: { filePath: '/repo/old/a.ts', rootPath: '/repo/old' },
          }),
          createContextRef('code_selection', '/repo/old/b.ts', 'b.ts', {
            meta: { filePath: '/repo/old/b.ts', rootPath: '/repo/old' },
          }),
          createContextRef('code_file', '/repo/new/c.ts', 'c.ts', {
            meta: { filePath: '/repo/new/c.ts', rootPath: '/repo/new' },
          }),
          createContextRef('document', 'doc-1', '产品说明'),
        ],
      },
    })

    useContextInjectionStore.getState().pruneCodeRefsForRootChange('sess-1', '/repo/new')

    const remaining = useContextInjectionStore.getState().contextRefsByScopeId['sess-1']
    expect(remaining).toHaveLength(2)
    expect(remaining.map(ref => ref.type)).toEqual(['code_file', 'document'])
    expect(remaining[0].meta?.rootPath).toBe('/repo/new')
  })

  it('addContextRefToScope / addInjectedPayloadToScope 同样受代码根校验', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('sess-1', { rootPath: '/repo/bound' })

    const viaAddContextRef = useContextInjectionStore.getState().addContextRefToScope(
      'sess-1', 'code_file', '/repo/other/a.ts', 'a.ts',
      { meta: { filePath: '/repo/other/a.ts', rootPath: '/repo/other' } },
    )
    const viaPayload = useContextInjectionStore.getState().addInjectedPayloadToScope('sess-1', {
      type: 'code_selection',
      resourceId: '/repo/other/b.ts',
      label: 'b.ts',
      meta: { filePath: '/repo/other/b.ts', rootPath: '/repo/other' },
    })

    expect(viaAddContextRef.ok).toBe(false)
    expect(viaPayload.ok).toBe(false)
    expect(useContextInjectionStore.getState().contextRefsByScopeId['sess-1']).toBeUndefined()
  })
})
